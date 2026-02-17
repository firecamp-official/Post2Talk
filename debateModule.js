// ============================================
// DEBATE MODULE - SYSTÈME AVEC RÔLES
// ============================================
// Architecture : 1 Décisionnaire, 2 Avocats, Spectateurs
// Phases : QUESTION (30s) → DEBATE (60s) → VOTE (15s) → RESULT (10s)

class DebateModule {
    constructor(supabaseClient, audioManager) {
        this.client = supabaseClient;
        this.audio = audioManager;
        this.userId = this.client.getUserId();

        // État
        this.currentState = 'WAITING';
        this.currentSessionId = null;
        this.myRole = null; // 'decisionnaire', 'lawyer1', 'lawyer2', 'spectator'
        this.isActive = false;

        // Configuration temporelle
        this.config = {
            minPlayers: 4,            // ✅ CORRIGÉ : 4 joueurs minimum (1 décisionnaire + 2 avocats + 1 spectateur min)
            stabilizationTime: 5000,  // 5s pour stabiliser la liste des joueurs
            countdownTime: 3000,      // 3s compte à rebours
            questionTime: 30000,      // 30s pour le choix de la question
            debateTime: 60000,        // 60s pour le débat
            votingTime: 15000,        // 15s pour le vote
            resultTime: 10000         // 10s pour le résultat
        };

        // Données de session
        this.sessionData = {
            participants: [],
            decisionnaire: null,
            lawyer1: null,
            lawyer2: null,
            spectators: [],
            question: '',
            lawyerMessages: [],      // Messages des avocats uniquement
            spectatorMessages: [],   // Messages des spectateurs
            votes: {},               // { userId: 'lawyer1' | 'lawyer2' }
            stateStartTime: Date.now()
        };

        this.lastMessageTime = 0;
        this.messageCooldown = 2000; // 2s entre chaque message

        // 🔴 Realtime channel
        this.realtimeChannel = null;
        this.timerInterval = null;
        
        // 🔌 Suivi des déconnexions
        this._previousParticipants = null; // snapshot de la liste avant le dernier update

        this.init();
    }

    async init() {
        console.log('🎭 [DEBATE] Initialisation module débat avec rôles...');

        this.createUI();
        this.createDebateBadge();
        this.setupEventListeners();
        
        // 🔴 REALTIME : Une seule requête initiale + écoute passive
        this.startRealtimeSync();

        console.log('✅ [DEBATE] Module initialisé avec Realtime');
    }

    createDebateBadge() {
        const header = document.querySelector('.header .container');
        if (!header) return;

        const badge = document.createElement('div');
        badge.id = 'debateBadge';
        badge.className = 'debate-badge';
        badge.innerHTML = `
            <div class="debate-badge-content">
                <span class="debate-status-dot"></span>
                <span class="debate-badge-text">Débat Live</span>
                <span class="debate-participant-count">0</span>
            </div>
        `;

        badge.addEventListener('click', () => this.openDebateModule());
        header.appendChild(badge);
    }

    createUI() {
        const modalHTML = `
            <div class="modal debate-module-modal" id="debateModuleModal">
                <div class="debate-module-container">
                    <button class="debate-close-btn" id="closeDebateModule">✖</button>
                    
                    <!-- Header avec timer et info -->
                    <div class="debate-header">
                        <div class="debate-state-info">
                            <span class="debate-state-icon">⏳</span>
                            <span class="debate-state-text" id="debateStateText">En attente...</span>
                        </div>
                        <div class="debate-timer" id="debateTimer">--:--</div>
                        <div class="debate-participants-info">
                            <span class="participant-icon">👥</span>
                            <span id="debateParticipantCount">0</span>/4+
                        </div>
                    </div>
                    
                    <!-- Zone principale d'affichage -->
                    <div class="debate-main-area" id="debateMainArea">
                        <div class="debate-waiting-screen">
                            <div class="debate-waiting-icon">⏳</div>
                            <h2>Chargement...</h2>
                        </div>
                    </div>
                    
                    <!-- Zone d'interaction (inputs, boutons) -->
                    <div class="debate-interaction-area" id="debateInteractionArea"></div>
                    
                    <!-- Footer avec badge de rôle -->
                    <div class="debate-footer">
                        <div class="debate-role-badge" id="debateRoleBadge">
                            <span class="role-icon">👤</span>
                            <span id="debateRoleText">En attente d'attribution...</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    setupEventListeners() {
        document.getElementById('closeDebateModule')?.addEventListener('click', () => {
            this.closeDebateModule();
        });
    }

    // ============================================
    // 🔴 REALTIME SYNC (remplace le heartbeat)
    // ============================================

    startRealtimeSync() {
        console.log('[DEBATE] 🔴 Démarrage Realtime sync...');
        
        // Timer local (1s) : affichage + vérification des transitions d'état
        this.timerInterval = setInterval(() => {
            this.updateTimerOnly();
            // Le leader vérifie si une transition est nécessaire (même sans event Realtime entrant)
            if (this.currentSessionId && this.currentState !== 'WAITING') {
                this.checkStateProgression();
            }
        }, 1000);
        
        // S'abonner aux changements en temps réel
        this.realtimeChannel = this.client.client
            .channel('debate_sessions_changes')
            .on(
                'postgres_changes',
                {
                    event: '*', // INSERT, UPDATE, DELETE
                    schema: 'public',
                    table: 'debate_sessions',
                    filter: 'is_active=eq.true'
                },
                (payload) => {
                    console.log('[DEBATE] 📡 Changement détecté');
                    this.handleRealtimeUpdate(payload);
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('[DEBATE] ✅ Realtime connecté');
                }
            });
        
        // Chargement initial (une seule requête)
        this.loadInitialSession();
    }

    // Chargement initial de la session
    async loadInitialSession() {
        try {
            const { data: sessions } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('is_active', true)
                .limit(1);
            
            if (!sessions || sessions.length === 0) {
                this.currentSessionId = null;
                this.currentState = 'WAITING';
                this.sessionData.participants = [];
                this.myRole = null;
            } else {
                const session = sessions[0];
                this.updateFromSession(session);
            }
            
            this.updateBadge();
            if (this.isActive) {
                this.updateUI();
            }
            
            // Initialiser le snapshot de présence APRÈS le chargement initial (évite les faux positifs)
            this._previousParticipants = [...(this.sessionData.participants || [])];
        } catch (error) {
            console.error('[DEBATE] Erreur chargement initial:', error);
        }
    }

    // Gérer les updates Realtime
    async handleRealtimeUpdate(payload) {
        const { eventType, new: newRecord, old: oldRecord } = payload;
        
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
            if (newRecord && newRecord.is_active) {
                this.updateFromSession(newRecord);
            } else if (newRecord && !newRecord.is_active && this.currentSessionId === newRecord.id) {
                // Session devenue inactive → reset complet
                console.log('[DEBATE] 📡 Session désactivée par un pair');
                if (this.isActive) {
                    this.showDebateToast('💀 La partie a été interrompue.', 'error');
                }
                this._resetLocalState();
            }
        } else if (eventType === 'DELETE') {
            // Session supprimée
            console.log('[DEBATE] 📡 Session supprimée');
            this._resetLocalState();
        }
        
        // Mettre à jour l'UI
        this.updateBadge();
        if (this.isActive) {
            this.updateUI();
            await this.checkStateProgression();
        }
    }

    // Extraire les données d'une session
    updateFromSession(session) {
        // Snapshot avant mise à jour (pour détecter les départs)
        const previousParticipants = this._previousParticipants !== null
            ? this._previousParticipants
            : (this.sessionData.participants ? [...this.sessionData.participants] : []);

        this.currentSessionId = session.id;
        
        // Reset du verrou de déconnexion si l'état change
        if (this.currentState !== session.state) {
            this._disconnectionHandled = false;
        }
        this.currentState = session.state;
        
        // ✅ Les colonnes JSONB sont déjà des objets/arrays JavaScript
        this.sessionData = {
            participants: session.participants || [],
            decisionnaire: session.decisionnaire || null,
            lawyer1: session.lawyer1 || null,
            lawyer2: session.lawyer2 || null,
            spectators: [], // Calculé depuis participants
            question: session.question || '',
            lawyerMessages: session.lawyer_messages || [],
            spectatorMessages: session.spectator_messages || [],
            votes: session.votes || {},
            stateStartTime: session.state_start_time || Date.now(),
            forfeitReason: session.forfeit_reason || null
        };
        
        this.updateMyRole();
        
        // Détecter les déconnexions seulement si la liste a vraiment changé
        const currentIds = [...this.sessionData.participants].sort().join(',');
        const previousIds = [...previousParticipants].sort().join(',');
        if (previousIds !== currentIds) {
            this._handleDisconnections(previousParticipants, this.sessionData.participants);
        }
        this._previousParticipants = [...this.sessionData.participants];
    }
    
    // Helper pour sauvegarder la session dans la DB
    getSessionUpdateObject() {
        return {
            participants: this.sessionData.participants || [],
            decisionnaire: this.sessionData.decisionnaire,
            lawyer1: this.sessionData.lawyer1,
            lawyer2: this.sessionData.lawyer2,
            question: this.sessionData.question || '',
            lawyer_messages: this.sessionData.lawyerMessages || [],
            spectator_messages: this.sessionData.spectatorMessages || [],
            votes: this.sessionData.votes || {},
            state_start_time: this.sessionData.stateStartTime || Date.now()
        };
    }

    // Arrêter le Realtime (si besoin)
    stopRealtimeSync() {
        if (this.realtimeChannel) {
            this.client.client.removeChannel(this.realtimeChannel);
            this.realtimeChannel = null;
            console.log('[DEBATE] ⏹️ Realtime déconnecté');
        }
        
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    // Mise à jour du timer uniquement (sans requête DB)
    updateTimerOnly() {
        const timer = document.getElementById('debateTimer');
        if (!timer) return;

        const elapsed = Date.now() - this.sessionData.stateStartTime;
        let duration = 0;

        switch (this.currentState) {
            case 'STABILIZING': duration = this.config.stabilizationTime; break;
            case 'COUNTDOWN': duration = this.config.countdownTime; break;
            case 'QUESTION': duration = this.config.questionTime; break; // FIXÉ
            case 'DEBATE': duration = this.config.debateTime; break;
            case 'VOTING': duration = this.config.votingTime; break;
            case 'RESULT': duration = this.config.resultTime; break;
        }

        const remaining = Math.max(0, duration - elapsed);
        const secs = Math.floor(remaining / 1000);
        const mins = Math.floor(secs / 60);
        timer.textContent = `${mins}:${(secs % 60).toString().padStart(2, '0')}`;
        
        // HYPE : États visuels selon l'urgence
        timer.classList.remove('timer-normal', 'timer-warning', 'timer-critical');
        
        if (secs <= 10) {
            timer.classList.add('timer-critical'); // Rouge, pulse rapide
        } else if (secs <= 30) {
            timer.classList.add('timer-warning'); // Orange, pulse moyen
        } else {
            timer.classList.add('timer-normal'); // Normal
        }
        
        // HYPE : Badge LIVE pulse plus vite si <30s pendant DEBATE
        const badge = document.getElementById('debateBadge');
        if (badge) {
            if (this.currentState === 'DEBATE' && secs <= 30) {
                badge.classList.add('pulse-fast');
            } else {
                badge.classList.remove('pulse-fast');
            }
        }
    }

    updateMyRole() {
        if (this.sessionData.decisionnaire === this.userId) {
            this.myRole = 'decisionnaire';
        } else if (this.sessionData.lawyer1 === this.userId) {
            this.myRole = 'lawyer1';
        } else if (this.sessionData.lawyer2 === this.userId) {
            this.myRole = 'lawyer2';
        } else {
            this.myRole = 'spectator';
        }
    }

    // ============================================
    // UPDATES LÉGERS (sans détruire les inputs)
    // ============================================
    
    updateDebateMessagesOnly() {
        const lawyersChat = document.getElementById('lawyersChat');
        const spectatorsChat = document.getElementById('spectatorsChat');
        
        if (lawyersChat) {
            let messagesHTML = '';
            for (const msg of this.sessionData.lawyerMessages) {
                const isLawyer1 = msg.role === 'lawyer1';
                const lawyerName = isLawyer1 ? 'Avocat 1' : 'Avocat 2';
                const lawyerClass = isLawyer1 ? 'lawyer-1' : 'lawyer-2';
                
                messagesHTML += `
                    <div class="lawyer-message ${lawyerClass}">
                        <div class="lawyer-name">${lawyerName}</div>
                        <div class="lawyer-text">${msg.content}</div>
                    </div>
                `;
            }
            lawyersChat.innerHTML = messagesHTML || '<p class="no-messages">Aucun message pour le moment...</p>';
            lawyersChat.scrollTop = lawyersChat.scrollHeight;
        }
        
        if (spectatorsChat) {
            let spectatorHTML = '';
            for (const msg of this.sessionData.spectatorMessages) {
                const isMe = msg.userId === this.userId;
                spectatorHTML += `
                    <div class="spectator-message ${isMe ? 'my-message' : ''}">
                        <span class="spectator-text">${msg.content}</span>
                    </div>
                `;
            }
            spectatorsChat.innerHTML = spectatorHTML || '<p class="no-messages">Aucun commentaire...</p>';
            spectatorsChat.scrollTop = spectatorsChat.scrollHeight;
        }
    }
    
    updateVoteCountsOnly() {
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const totalVotes = votes1 + votes2;
        
        const voteCards = document.querySelectorAll('.debate-vote-card');
        if (voteCards.length === 2) {
            // Carte Avocat 1
            const count1 = voteCards[0].querySelector('.vote-count');
            if (count1) {
                count1.textContent = `${votes1} ${votes1 > 1 ? 'votes' : 'vote'}`;
            }
            if (totalVotes > 0) {
                const percent1 = voteCards[0].querySelector('.vote-percentage');
                if (percent1) {
                    percent1.textContent = `${Math.round(votes1 / totalVotes * 100)}%`;
                }
            }
            
            // Carte Avocat 2
            const count2 = voteCards[1].querySelector('.vote-count');
            if (count2) {
                count2.textContent = `${votes2} ${votes2 > 1 ? 'votes' : 'vote'}`;
            }
            if (totalVotes > 0) {
                const percent2 = voteCards[1].querySelector('.vote-percentage');
                if (percent2) {
                    percent2.textContent = `${Math.round(votes2 / totalVotes * 100)}%`;
                }
            }
        }
        
        const voteCount = document.querySelector('.debate-vote-count');
        if (voteCount) {
            voteCount.textContent = `Total : ${totalVotes} ${totalVotes > 1 ? 'votes' : 'vote'}`;
        }
    }

    // ============================================
    // PROGRESSION D'ÉTAT
    // ============================================

    async checkStateProgression() {
        const count = this.sessionData.participants?.length || 0;
        const elapsed = Date.now() - this.sessionData.stateStartTime;

        // Système de "leader" : seul le premier participant fait la transition
        // Cela réduit drastiquement les requêtes simultanées
        const isLeader = this.sessionData.participants[0] === this.userId;

        if (!isLeader) {
            // Les non-leaders observent seulement
            return;
        }

        // Ajouter un petit délai aléatoire pour éviter les conflits
        const randomDelay = Math.random() * 200;

        switch (this.currentState) {
            case 'WAITING':
                // ✅ Attendre 4+ joueurs
                if (count >= this.config.minPlayers) {
                    setTimeout(() => this.transitionToState('STABILIZING'), randomDelay);
                }
                break;

            case 'STABILIZING':
                // ✅ Si quelqu'un quitte pendant la stabilisation → retour WAITING
                if (count < this.config.minPlayers) {
                    console.log('[DEBATE] ⚠️ Pas assez de joueurs, retour WAITING');
                    setTimeout(() => this.transitionToState('WAITING'), randomDelay);
                    return;
                }
                
                // ✅ Si quelqu'un rejoint/quitte → reset la stabilisation
                if (this.hasParticipantsChanged()) {
                    console.log('[DEBATE] 🔄 Liste des joueurs modifiée, reset stabilisation');
                    this.sessionData.stateStartTime = Date.now();
                    this.lastParticipantsList = [...this.sessionData.participants];
                    await this.saveSession();
                    return;
                }
                
                // ✅ Après 5s stable → lancer le countdown
                if (elapsed >= this.config.stabilizationTime) {
                    setTimeout(() => this.transitionToState('COUNTDOWN'), randomDelay);
                }
                break;

            case 'COUNTDOWN':
                // ✅ Si quelqu'un quitte pendant countdown → retour STABILIZING
                if (count < this.config.minPlayers) {
                    console.log('[DEBATE] ⚠️ Pas assez de joueurs, retour STABILIZING');
                    setTimeout(() => this.transitionToState('STABILIZING'), randomDelay);
                    return;
                }
                
                if (elapsed >= this.config.countdownTime) {
                    // Attribuer les rôles et passer à QUESTION
                    setTimeout(async () => {
                        await this.assignRoles();
                        await this.transitionToState('QUESTION');
                    }, randomDelay);
                }
                break;

            case 'QUESTION':
            case 'DEBATE':
            case 'VOTING': {
                // Filet de sécurité : vérifier les avocats depuis le timer (si Realtime a raté un départ)
                const l1 = this.sessionData.lawyer1;
                const l2 = this.sessionData.lawyer2;
                const participants = this.sessionData.participants;
                const lockKey = `${this.currentSessionId}_${this.currentState}`;
                
                if (l1 && l2 && this._disconnectionHandled !== lockKey) {
                    const l1Present = participants.includes(l1);
                    const l2Present = participants.includes(l2);
                    
                    if (!l1Present && !l2Present) {
                        this._disconnectionHandled = lockKey;
                        console.log('[DEBATE] ⏱️ Filet sécurité: les deux avocats absents');
                        if (this.audio) this.audio.playSound('debatEnd');
                        setTimeout(() => this._endSessionAbruptly('Les deux avocats ont quitté la partie'), 500);
                        break;
                    } else if (!l1Present) {
                        this._disconnectionHandled = lockKey;
                        console.log('[DEBATE] ⏱️ Filet sécurité: Avocat 1 absent');
                        if (this.audio) this.audio.playSound('debatEnd');
                        setTimeout(() => this._endSessionWithForfeit('lawyer2', 'Avocat 1 a abandonné la partie'), 500);
                        break;
                    } else if (!l2Present) {
                        this._disconnectionHandled = lockKey;
                        console.log('[DEBATE] ⏱️ Filet sécurité: Avocat 2 absent');
                        if (this.audio) this.audio.playSound('debatEnd');
                        setTimeout(() => this._endSessionWithForfeit('lawyer1', 'Avocat 2 a abandonné la partie'), 500);
                        break;
                    }
                }
                
                if (this.currentState === 'QUESTION' && elapsed >= this.config.questionTime) {
                    setTimeout(async () => {
                        if (!this.sessionData.question) {
                            await this.setDefaultQuestion();
                        }
                        await this.transitionToState('DEBATE');
                    }, randomDelay);
                } else if (this.currentState === 'DEBATE' && elapsed >= this.config.debateTime) {
                    setTimeout(() => this.transitionToState('VOTING'), randomDelay);
                } else if (this.currentState === 'VOTING' && elapsed >= this.config.votingTime) {
                    setTimeout(() => this.transitionToState('RESULT'), randomDelay);
                }
                break;
            }

            case 'RESULT':
                if (elapsed >= this.config.resultTime) {
                    setTimeout(() => this.endSession(), randomDelay);
                }
                break;
        }
    }
    
    // ✅ NOUVEAU : Détecter si la liste des participants a changé
    hasParticipantsChanged() {
        if (!this.lastParticipantsList) {
            this.lastParticipantsList = [...this.sessionData.participants];
            return false;
        }
        
        const current = [...this.sessionData.participants].sort();
        const last = [...this.lastParticipantsList].sort();
        
        if (current.length !== last.length) return true;
        
        for (let i = 0; i < current.length; i++) {
            if (current[i] !== last[i]) return true;
        }
        
        return false;
    }
    
    // ✅ NOUVEAU : Sauvegarder la session sans changer d'état
    async saveSession() {
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
        } catch (error) {
            console.error('[DEBATE] Erreur sauvegarde:', error);
        }
    }

    async transitionToState(newState) {
        console.log(`[DEBATE] Transition: ${this.currentState} → ${newState}`);

        this.sessionData.stateStartTime = Date.now();
        
        const updateData = {
            state: newState,
            ...this.getSessionUpdateObject()
        };
        
        console.log('[DEBATE] 📝 Données à envoyer:', updateData);

        try {
            const { data, error } = await this.client.client
                .from('debate_sessions')
                .update(updateData)
                .eq('id', this.currentSessionId)
                .select();

            if (error) {
                console.error('[DEBATE] ❌ Erreur complète:', error);
                console.error('[DEBATE] Code:', error.code);
                console.error('[DEBATE] Message:', error.message);
                console.error('[DEBATE] Details:', error.details);
                throw error;
            }

            console.log(`[DEBATE] ✅ État changé: ${newState}`);
        } catch (error) {
            console.error('[DEBATE] Erreur transition:', error);
            console.error('[DEBATE] Données problématiques:', updateData);
        }
    }

    async assignRoles() {
        // Mélanger les participants
        const shuffled = [...this.sessionData.participants].sort(() => Math.random() - 0.5);

        this.sessionData.decisionnaire = shuffled[0];
        this.sessionData.lawyer1 = shuffled[1];
        this.sessionData.lawyer2 = shuffled[2];
        this.sessionData.spectators = shuffled.slice(3);

        console.log('[DEBATE] Rôles attribués:', {
            decisionnaire: this.sessionData.decisionnaire,
            lawyer1: this.sessionData.lawyer1,
            lawyer2: this.sessionData.lawyer2,
            spectators: this.sessionData.spectators
        });

        // Sauvegarder
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
        } catch (error) {
            console.error('[DEBATE] Erreur attribution rôles:', error);
        }
    }

    async setDefaultQuestion() {
        const defaultQuestions = [
            "Les chats sont-ils meilleurs que les chiens ?",
            "L'ananas a-t-il sa place sur une pizza ?",
            "Est-il préférable d'être riche ou célèbre ?",
            "Pain au chocolat ou chocolatine ?",
            "Les séries sont-elles meilleures que les films ?"
        ];

        this.sessionData.question = defaultQuestions[Math.floor(Math.random() * defaultQuestions.length)];

        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);
        } catch (error) {
            console.error('[DEBATE] Erreur question par défaut:', error);
        }
    }

    async endSession() {
        console.log('[DEBATE] 🏁 Fin de la session');

        try {
            // Désactiver la session
            await this.client.client
                .from('debate_sessions')
                .update({
                    is_active: false
                })
                .eq('id', this.currentSessionId);

            console.log('[DEBATE] ✅ Session fermée:', this.currentSessionId);
            
            // Réinitialiser l'état local
            this._resetLocalState();

        } catch (error) {
            console.error('[DEBATE] Erreur fin session:', error);
        }
    }

    // ============================================
    // 🔌 GESTION DES DÉCONNEXIONS
    // ============================================

    /**
     * Détecte qui a quitté et applique les règles selon le rôle et la phase.
     * Appelé à chaque updateFromSession, APRÈS que sessionData est mis à jour.
     */
    _handleDisconnections(previous, current) {
        // Pas de tracking pendant WAITING/STABILIZING/COUNTDOWN (déjà géré par checkStateProgression)
        const activePhases = ['QUESTION', 'DEBATE', 'VOTING', 'RESULT'];
        if (!activePhases.includes(this.currentState)) return;
        if (!previous || previous.length === 0) return;

        // Trouver qui a disparu
        const departed = previous.filter(uid => !current.includes(uid));
        if (departed.length === 0) return;

        console.log('[DEBATE] 🔌 Départ détecté:', departed, 'phase:', this.currentState);

        const lawyer1 = this.sessionData.lawyer1;
        const lawyer2 = this.sessionData.lawyer2;
        const decisionnaire = this.sessionData.decisionnaire;

        const lawyer1Left = departed.includes(lawyer1);
        const lawyer2Left = departed.includes(lawyer2);
        const decisionnaireLeft = departed.includes(decisionnaire);

        // Règle 1 : Les deux avocats partent → fin immédiate, match nul
        if (lawyer1Left && lawyer2Left) {
            console.log('[DEBATE] ⚠️ Les deux avocats ont quitté → fin de session');
            this.showDebateToast('💀 Les deux avocats ont quitté — partie annulée !', 'error');
            if (this.audio) this.audio.playSound('debatEnd');
            // Seul le leader termine
            if (this.sessionData.participants[0] === this.userId || this.userId === lawyer1 || this.userId === lawyer2) {
                setTimeout(() => this._endSessionAbruptly('Les deux avocats ont quitté la partie'), 2000);
            }
            return;
        }

        // Règle 2 : Avocat 1 part seul → Avocat 2 gagne
        if (lawyer1Left && !lawyer2Left && this.currentState !== 'RESULT') {
            console.log('[DEBATE] ⚠️ Avocat 1 a quitté → Avocat 2 gagne');
            this.showDebateToast('🏃 L\'Avocat 1 a quitté la partie — Avocat 2 gagne !', 'error');
            if (this.audio) this.audio.playSound('debatEnd');
            if (this._isLeader()) {
                setTimeout(() => this._endSessionWithForfeit('lawyer2', 'Avocat 1 a abandonné la partie'), 2000);
            }
            return;
        }

        // Règle 3 : Avocat 2 part seul → Avocat 1 gagne
        if (lawyer2Left && !lawyer1Left && this.currentState !== 'RESULT') {
            console.log('[DEBATE] ⚠️ Avocat 2 a quitté → Avocat 1 gagne');
            this.showDebateToast('🏃 L\'Avocat 2 a quitté la partie — Avocat 1 gagne !', 'error');
            if (this.audio) this.audio.playSound('debatEnd');
            if (this._isLeader()) {
                setTimeout(() => this._endSessionWithForfeit('lawyer1', 'Avocat 2 a abandonné la partie'), 2000);
            }
            return;
        }

        // Règle 4 : Décisionnaire part pendant QUESTION → question aléatoire auto
        if (decisionnaireLeft && this.currentState === 'QUESTION' && !this.sessionData.question) {
            console.log('[DEBATE] ⚠️ Décisionnaire a quitté en phase QUESTION → question automatique');
            this.showDebateToast('⚖️ Le décisionnaire a quitté — question choisie automatiquement !', 'warning');
            if (this._isLeader()) {
                setTimeout(async () => {
                    await this.setDefaultQuestion();
                    await this.transitionToState('DEBATE');
                }, 1500);
            }
            return;
        }

        // Règle 5 : Tous les spectateurs partent
        if (this.currentState === 'DEBATE' || this.currentState === 'VOTING') {
            const remainingSpectators = current.filter(
                uid => uid !== lawyer1 && uid !== lawyer2 && uid !== decisionnaire
            );
            if (remainingSpectators.length === 0 && previous.filter(
                uid => uid !== lawyer1 && uid !== lawyer2 && uid !== decisionnaire
            ).length > 0) {
                console.log('[DEBATE] ⚠️ Tous les spectateurs sont partis');
                this.showDebateToast('👻 Tous les spectateurs sont partis — le débat continue sans audience !', 'warning');
                // On ne coupe pas la partie, on continue
            }
        }

        // Règle 6 : Décisionnaire part pendant VOTING ou DEBATE → juste info
        if (decisionnaireLeft && (this.currentState === 'DEBATE' || this.currentState === 'VOTING')) {
            this.showDebateToast('⚖️ Le décisionnaire a quitté — le débat continue !', 'warning');
        }
    }

    /** Réinitialise tout l'état local (appelé quand la session se termine) */
    _resetLocalState() {
        this.currentSessionId = null;
        this.currentState = 'WAITING';
        this.myRole = null;
        this._previousParticipants = null;
        this._disconnectionHandled = false;
        this.sessionData = {
            participants: [],
            decisionnaire: null,
            lawyer1: null,
            lawyer2: null,
            spectators: [],
            question: '',
            lawyerMessages: [],
            spectatorMessages: [],
            votes: {},
            stateStartTime: Date.now(),
            forfeitReason: null
        };
    }

    /** Indique si ce client est le leader de la session (premier participant) */
    _isLeader() {
        return this.sessionData.participants.length > 0 &&
            this.sessionData.participants[0] === this.userId;
    }

    /** Termine la session en déclarant un gagnant par forfait */
    async _endSessionWithForfeit(winner, reason) {
        if (!this.currentSessionId) return;
        
        console.log('[DEBATE] 🏁 Fin par forfait, gagnant:', winner, 'raison:', reason);
        
        // Votes fictifs : tout le monde vote pour le gagnant
        const fakeVotes = { '__forfeit__': winner };
        const spectators = this.sessionData.participants.filter(
            uid => uid !== this.sessionData.lawyer1 &&
                   uid !== this.sessionData.lawyer2 &&
                   uid !== this.sessionData.decisionnaire
        );
        spectators.forEach(s => { fakeVotes[s] = winner; });
        
        this.sessionData.votes = fakeVotes;
        this.sessionData.stateStartTime = Date.now();
        // Stocker la raison du forfait pour l'affichage
        this.sessionData.forfeitReason = reason || null;
        
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    state: 'RESULT',
                    forfeit_reason: reason || null,
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);
        } catch (error) {
            console.error('[DEBATE] Erreur forfait:', error);
        }
    }

    /** Termine la session brutalement avec un message (les deux avocats partis, etc.) */
    async _endSessionAbruptly(reason) {
        if (!this.currentSessionId) return;
        
        console.log('[DEBATE] 💀 Fin abrupte:', reason);
        
        // Stocker la raison pour l'afficher avant de fermer
        this.sessionData.forfeitReason = reason;
        
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    state: 'RESULT',
                    forfeit_reason: reason,
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);
            
            // Fermer la session après le délai d'affichage du résultat
            setTimeout(async () => {
                await this.client.client
                    .from('debate_sessions')
                    .update({ is_active: false })
                    .eq('id', this.currentSessionId);
            }, (this.config.resultTime || 10000) + 1000);
            
        } catch (error) {
            console.error('[DEBATE] Erreur fin abrupte:', error);
        }
    }

    // ============================================
    // GESTION DES MESSAGES
    // ============================================

    async sendLawyerMessage(message) {
        // Seuls les avocats peuvent envoyer ici
        if (this.myRole !== 'lawyer1' && this.myRole !== 'lawyer2') {
            this.showDebateToast('Seuls les avocats peuvent écrire ici !', 'error');
            return;
        }

        // Cooldown
        const now = Date.now();
        if (now - this.lastMessageTime < this.messageCooldown) {
            const remaining = Math.ceil((this.messageCooldown - (now - this.lastMessageTime)) / 1000);
            this.showDebateToast(`Attends ${remaining}s avant d\'écrire à nouveau`, 'warning');
            return;
        }

        // Validation
        if (!message || message.trim().length === 0) return;
        if (message.length > 200) {
            this.showDebateToast('Message trop long (max 200 caractères)', 'error');
            return;
        }

        this.lastMessageTime = now;

        const newMessage = {
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            userId: this.userId,
            role: this.myRole,
            content: this.escapeHTML(message),
            timestamp: Date.now()
        };

        // Ajouter localement d'abord pour feedback immédiat
        this.sessionData.lawyerMessages.push(newMessage);
        this.updateDebateMessages();

        // Envoyer à la DB de manière asynchrone
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);

            if (this.audio) {
                this.audio.playSound('addOpinion');
            }
        } catch (error) {
            console.error('[DEBATE] Erreur envoi message avocat:', error);
            // Retirer le message local en cas d'erreur
            this.sessionData.lawyerMessages.pop();
            this.updateDebateMessages();
            this.showDebateToast('Erreur d\'envoi du message', 'error');
        }
    }

    async sendSpectatorMessage(message) {
        // Seuls les spectateurs peuvent envoyer ici
        if (this.myRole !== 'spectator') {
            this.showDebateToast('Seuls les spectateurs peuvent écrire ici !', 'error');
            return;
        }

        // Cooldown
        const now = Date.now();
        if (now - this.lastMessageTime < this.messageCooldown) {
            const remaining = Math.ceil((this.messageCooldown - (now - this.lastMessageTime)) / 1000);
            this.showDebateToast(`Attends ${remaining}s avant d\'écrire à nouveau`, 'warning');
            return;
        }

        // Validation
        if (!message || message.trim().length === 0) return;
        if (message.length > 150) {
            this.showDebateToast('Message trop long (max 150 caractères)', 'error');
            return;
        }

        this.lastMessageTime = now;

        const newMessage = {
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            userId: this.userId,
            content: this.escapeHTML(message),
            timestamp: Date.now()
        };

        // Ajouter localement d'abord pour feedback immédiat
        this.sessionData.spectatorMessages.push(newMessage);
        this.updateDebateMessages();

        // Envoyer à la DB de manière asynchrone
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);

            if (this.audio) {
                this.audio.playSound('setPostIt');
            }
        } catch (error) {
            console.error('[DEBATE] Erreur envoi message spectateur:', error);
            // Retirer le message local en cas d'erreur
            this.sessionData.spectatorMessages.pop();
            this.updateDebateMessages();
            this.showDebateToast('Erreur d\'envoi du message', 'error');
        }
    }

    async submitQuestion(question) {
        // Seul le décisionnaire peut soumettre la question
        if (this.myRole !== 'decisionnaire') {
            this.showDebateToast('Seul le décisionnaire peut choisir la question !', 'error');
            return;
        }

        // Validation
        if (!question || question.trim().length === 0) {
            this.showDebateToast('La question ne peut pas être vide', 'error');
            return;
        }

        if (question.length > 120) {
            this.showDebateToast('Question trop longue (max 120 caractères)', 'error');
            return;
        }

        this.sessionData.question = this.escapeHTML(question);

        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);

            this.showDebateToast('Question enregistrée !', 'success');

            if (this.audio) {
                this.audio.playSound('setPostIt');
            }
        } catch (error) {
            console.error('[DEBATE] Erreur soumission question:', error);
        }
    }

    async submitVote(lawyerId) {
        // Seuls les spectateurs peuvent voter
        if (this.myRole !== 'spectator') {
            this.showDebateToast('Seuls les spectateurs peuvent voter !', 'error');
            return;
        }

        // Vérifier qu'on n'a pas déjà voté
        if (this.sessionData.votes[this.userId]) {
            this.showDebateToast('Tu as déjà voté !', 'warning');
            return;
        }

        this.sessionData.votes[this.userId] = lawyerId;

        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    ...this.getSessionUpdateObject()
                })
                .eq('id', this.currentSessionId);

            this.showDebateToast('Vote enregistré !', 'success');

            if (this.audio) {
                this.audio.playSound('afterVoting');
            }
            
            // HYPE : Vérifier si changement de leader
            this.checkAndAnnounceLeaderChange();
            
        } catch (error) {
            console.error('[DEBATE] Erreur vote:', error);
        }
    }
    
    // ============================================
    // CLEANUP AUTOMATIQUE
    // ============================================
    
    async cleanupOldSessions() {
        try {
            console.log('[DEBATE] 🧹 Nettoyage des sessions zombies...');
            
            // Récupérer TOUTES les sessions actives pour un nettoyage précis
            const { data: sessions, error } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('is_active', true);
            
            if (error) throw error;
            
            if (!sessions || sessions.length === 0) {
                console.log('[DEBATE] ✅ Aucune session active');
                return;
            }
            
            const now = Date.now();
            const sessionsToClean = [];
            
            // Calculer le temps max d'une session
            const maxSessionTime = 
                this.config.stabilizationTime +
                this.config.countdownTime +
                this.config.questionTime +
                this.config.debateTime +
                this.config.votingTime +
                this.config.resultTime +
                30000; // +30s de marge (réduit de 60s pour être plus agressif)
            
            for (const session of sessions) {
                let shouldClean = false;
                let reason = '';
                
                try {
                    // state_start_time est une colonne directe (ms timestamp), pas dans session.data
                    const stateStartTime = session.state_start_time || 0;
                    const age = now - stateStartTime;
                    
                    // Critère 1 : Session trop vieille (dépasse le temps max)
                    if (age > maxSessionTime) {
                        shouldClean = true;
                        reason = `trop vieille (${Math.floor(age/1000)}s)`;
                    }
                    
                    // Critère 2 : WAITING depuis plus de 3 minutes (réduit de 5 à 3)
                    else if (session.state === 'WAITING' && age > 180000) {
                        shouldClean = true;
                        reason = `WAITING abandonné (${Math.floor(age/1000)}s)`;
                    }
                    
                    // Critère 3 : RESULT depuis plus de 30s (devrait être fini)
                    else if (session.state === 'RESULT' && age > 30000) {
                        shouldClean = true;
                        reason = `RESULT expiré (${Math.floor(age/1000)}s)`;
                    }
                    
                    // Critère 4 : Aucun participant (session vide)
                    else if (!session.participants || session.participants.length === 0) {
                        shouldClean = true;
                        reason = 'aucun participant';
                    }
                    
                } catch (parseError) {
                    // Si erreur inattendue, on ignore cette session
                    console.warn('[DEBATE] Erreur lecture session', session.id, parseError);
                }
                
                if (shouldClean) {
                    sessionsToClean.push(session.id);
                    console.log(`[DEBATE] 🧟 Zombie: ID ${session.id} (${session.state}, ${reason})`);
                }
            }
            
            // Nettoyer en une seule requête si nécessaire
            if (sessionsToClean.length > 0) {
                const { error: cleanError } = await this.client.client
                    .from('debate_sessions')
                    .update({ is_active: false })
                    .in('id', sessionsToClean);
                
                if (cleanError) throw cleanError;
                
                console.log(`[DEBATE] ✅ ${sessionsToClean.length} session(s) nettoyée(s)`);
            } else {
                console.log('[DEBATE] ✅ Toutes les sessions sont saines');
            }
            
        } catch (error) {
            console.error('[DEBATE] ⚠️ Erreur cleanup:', error);
            // Fallback ultra-simple : nettoyer TOUT ce qui est en WAITING
            try {
                console.log('[DEBATE] 🔄 Tentative cleanup fallback...');
                const { error: fallbackError } = await this.client.client
                    .from('debate_sessions')
                    .update({ is_active: false })
                    .eq('is_active', true)
                    .eq('state', 'WAITING');
                
                if (!fallbackError) {
                    console.log('[DEBATE] ✅ Cleanup fallback: toutes les sessions WAITING nettoyées');
                }
            } catch (fallbackError) {
                console.error('[DEBATE] ❌ Même le fallback a échoué:', fallbackError);
            }
        }
    }

    // ============================================
    // OUVERTURE/FERMETURE
    // ============================================

    async openDebateModule() {
        console.log('[DEBATE] Ouverture du module');

        // CLEANUP : Nettoyer les sessions zombies avant de commencer
        await this.cleanupOldSessions();

        // Chercher UNE session active (WAITING ou en cours)
        const { data: allActiveSessions } = await this.client.client
            .from('debate_sessions')
            .select('*')
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1);

        const existingSession = allActiveSessions?.[0] || null;

        if (existingSession) {
            // Rejoindre la session existante (peu importe son état)
            const session = existingSession;
            this.currentSessionId = session.id;
            this.currentState = session.state;

            this.sessionData = {
                participants: session.participants || [],
                decisionnaire: session.decisionnaire || null,
                lawyer1: session.lawyer1 || null,
                lawyer2: session.lawyer2 || null,
                spectators: [],
                question: session.question || '',
                lawyerMessages: session.lawyer_messages || [],
                spectatorMessages: session.spectator_messages || [],
                votes: session.votes || {},
                stateStartTime: session.state_start_time || Date.now(),
                forfeitReason: session.forfeit_reason || null
            };

            // Ajouter ce joueur SEULEMENT si la partie est en WAITING
            // (pendant la partie, les nouveaux arrivants observent sans modifier la liste)
            const inGameStates = ['QUESTION', 'DEBATE', 'VOTING', 'RESULT'];
            if (!this.sessionData.participants.includes(this.userId)) {
                if (!inGameStates.includes(this.currentState)) {
                    // Lobby : on rejoint
                    this.sessionData.participants.push(this.userId);
                    await this.client.client
                        .from('debate_sessions')
                        .update(this.getSessionUpdateObject())
                        .eq('id', this.currentSessionId);
                    console.log('[DEBATE] ✅ Session WAITING rejointe, participants:', this.sessionData.participants.length);
                } else {
                    // Partie en cours : on observe sans modifier la liste
                    console.log('[DEBATE] 👁️ Partie en cours, observation sans rejoindre');
                }
            } else {
                console.log('[DEBATE] ✅ Déjà dans la session');
            }

            this.updateMyRole();

        } else {
            // Créer une nouvelle session
            try {
                const { data, error } = await this.client.client
                    .from('debate_sessions')
                    .insert({
                        state: 'WAITING',
                        is_active: true,
                        participants: [this.userId],
                        decisionnaire: null,
                        lawyer1: null,
                        lawyer2: null,
                        question: '',
                        lawyer_messages: [],
                        spectator_messages: [],
                        votes: {},
                        state_start_time: Date.now(),
                        forfeit_reason: null
                    })
                    .select()
                    .single();

                if (error) throw error;

                this.currentSessionId = data.id;
                this.sessionData.participants = [this.userId];
                this.sessionData.stateStartTime = Date.now();
                console.log('[DEBATE] ✅ Nouvelle session créée');
            } catch (error) {
                console.error('[DEBATE] Erreur création:', error);
                return; // Sortir si la création échoue
            }
        }

        this.isActive = true;

        const modal = document.getElementById('debateModuleModal');
        if (modal) modal.classList.add('active');

        // Initialiser le snapshot APRÈS avoir tout chargé (évite faux positifs)
        this._previousParticipants = [...(this.sessionData.participants || [])];
        this._disconnectionHandled = false;

        this.updateUI();
        if (this.audio) this.audio.playSound('setPostIt');
    }

    closeDebateModule() {
        this.isActive = false;

        const modal = document.getElementById('debateModuleModal');
        if (modal) {
            modal.classList.remove('active');
        }
        
        // ⚠️ On NE retire PAS le joueur des participants ici :
        // fermer la modal ≠ quitter la partie.
        // Le retrait se fait uniquement à la fermeture de la page (beforeunload → _leaveSession).
    }

    /** Retire ce joueur des participants et met à jour la DB */
    _leaveSession() {
        if (!this.currentSessionId) return;
        
        const sessionId = this.currentSessionId;
        const newParticipants = this.sessionData.participants.filter(uid => uid !== this.userId);
        
        // Reset local immédiat (évite double-déclenchement)
        this._resetLocalState();
        
        // Si plus personne → désactiver la session
        if (newParticipants.length === 0) {
            console.log('[DEBATE] 🧹 Dernière personne partie, désactivation session');
            this.client.client
                .from('debate_sessions')
                .update({ is_active: false })
                .eq('id', sessionId)
                .catch(err => console.error('[DEBATE] Erreur désactivation:', err));
            return;
        }
        
        // Sinon : retirer juste ce joueur de la liste
        console.log('[DEBATE] 👋 Retrait de la session, participants restants:', newParticipants.length);
        this.client.client
            .from('debate_sessions')
            .update({ participants: newParticipants })
            .eq('id', sessionId)
            .catch(err => console.error('[DEBATE] Erreur retrait:', err));
    }

    // ============================================
    // UI UPDATE
    // ============================================

    updateBadge() {
        const badge = document.getElementById('debateBadge');
        if (!badge) return;

        const dot = badge.querySelector('.debate-status-dot');
        const text = badge.querySelector('.debate-badge-text');
        const count = badge.querySelector('.debate-participant-count');

        const participantCount = this.sessionData.participants?.length || 0;
        
        badge.classList.remove('waiting', 'stabilizing', 'active', 'voting', 'hype-high');

        switch (this.currentState) {
            case 'WAITING':
                badge.classList.add('waiting');
                if (participantCount === 0) {
                    text.textContent = 'Lobby vide';
                    count.textContent = '';
                } else if (participantCount < 4) {
                    text.textContent = 'En attente...';
                    count.textContent = `${participantCount}`;
                } else {
                    text.textContent = 'Prêt !';
                    count.textContent = `${participantCount} 🔥`;
                }
                break;
                
            case 'STABILIZING':
            case 'COUNTDOWN':
                badge.classList.add('stabilizing');
                text.textContent = 'Ça démarre !';
                count.textContent = `${participantCount}`;
                break;
                
            case 'QUESTION':
                badge.classList.add('active');
                text.textContent = '🔴 LIVE';
                count.textContent = `${participantCount} regardent`;
                break;
                
            case 'DEBATE':
                badge.classList.add('active');
                // Wording dynamique selon le nombre
                if (participantCount < 5) {
                    text.textContent = '🔴 LIVE';
                    count.textContent = `${participantCount}`;
                } else if (participantCount < 10) {
                    text.textContent = '🔴 Ça débat !';
                    count.textContent = `${participantCount}`;
                    badge.classList.add('hype-high');
                } else {
                    text.textContent = '🔴 Ça chauffe ! 🔥';
                    count.textContent = `${participantCount}`;
                    badge.classList.add('hype-high');
                }
                break;
                
            case 'VOTING':
                badge.classList.add('voting');
                const totalVotes = Object.keys(this.sessionData.votes || {}).length;
                const spectatorCount = this.sessionData.spectators?.length || 0;
                
                if (spectatorCount > 0) {
                    const voteRate = Math.round((totalVotes / spectatorCount) * 100);
                    if (voteRate > 70) {
                        text.textContent = 'Vote bouillant ! 🔥';
                        badge.classList.add('hype-high');
                    } else {
                        text.textContent = 'Vote en cours';
                    }
                    count.textContent = `${totalVotes}/${spectatorCount}`;
                } else {
                    text.textContent = 'Vote';
                    count.textContent = `${totalVotes}`;
                }
                break;
                
            case 'RESULT':
                badge.classList.add('active');
                text.textContent = 'Résultat ! 🏆';
                count.textContent = `${participantCount}`;
                break;
        }
    }

    updateUI() {
        const mainArea = document.getElementById('debateMainArea');
        const interactionArea = document.getElementById('debateInteractionArea');
        const participantCountEl = document.getElementById('debateParticipantCount');
        const stateText = document.getElementById('debateStateText');
        const timer = document.getElementById('debateTimer');
        const roleText = document.getElementById('debateRoleText');
        const roleBadge = document.getElementById('debateRoleBadge');

        if (!mainArea) return;

        // Sauvegarder l'état précédent pour éviter les re-renders inutiles
        const previousState = this.previousRenderState || {};
        const currentStateKey = `${this.currentState}_${this.myRole}_${this.sessionData.question}_${this.sessionData.votes[this.userId] || 'novote'}`;

        this.previousRenderState = this.previousRenderState || {};

        // Mettre à jour compteur
        if (participantCountEl) {
            participantCountEl.textContent = this.sessionData.participants?.length || 0;
        }

        // Mettre à jour timer
        if (timer) {
            const elapsed = Date.now() - this.sessionData.stateStartTime;
            let duration = 0;

            switch (this.currentState) {
                case 'STABILIZING': duration = this.config.stabilizationTime; break;
                case 'COUNTDOWN': duration = this.config.countdownTime; break;
                case 'QUESTION': duration = this.config.questionTime; break;
                case 'DEBATE': duration = this.config.debateTime; break;
                case 'VOTING': duration = this.config.votingTime; break;
                case 'RESULT': duration = this.config.resultTime; break;
            }

            const remaining = Math.max(0, duration - elapsed);
            const secs = Math.floor(remaining / 1000);
            const mins = Math.floor(secs / 60);
            timer.textContent = `${mins}:${(secs % 60).toString().padStart(2, '0')}`;
        }

        // Mettre à jour rôle
        if (roleText && roleBadge) {
            const roleIcons = {
                'decisionnaire': '⚖️',
                'lawyer1': '👔',
                'lawyer2': '👔',
                'spectator': '👁️'
            };

            const roleNames = {
                'decisionnaire': 'Décisionnaire',
                'lawyer1': 'Avocat 1',
                'lawyer2': 'Avocat 2',
                'spectator': 'Spectateur'
            };

            roleBadge.querySelector('.role-icon').textContent = roleIcons[this.myRole] || '👤';
            roleText.textContent = roleNames[this.myRole] || 'En attente...';

            // Colorer le badge selon le rôle
            roleBadge.classList.remove('role-decisionnaire', 'role-lawyer', 'role-spectator');
            if (this.myRole === 'decisionnaire') {
                roleBadge.classList.add('role-decisionnaire');
            } else if (this.myRole === 'lawyer1' || this.myRole === 'lawyer2') {
                roleBadge.classList.add('role-lawyer');
            } else if (this.myRole === 'spectator') {
                roleBadge.classList.add('role-spectator');
            }
        }

        // Mettre à jour texte d'état
        if (stateText) {
            const stateNames = {
                'WAITING': 'En attente de joueurs...',
                'STABILIZING': 'Stabilisation...',
                'COUNTDOWN': 'Démarrage imminent !',
                'QUESTION': '❓ Choix de la question',
                'DEBATE': '💬 Débat en cours',
                'VOTING': '🗳️ Phase de vote',
                'RESULT': '🏆 Résultat'
            };
            stateText.textContent = stateNames[this.currentState] || this.currentState;
        }

        // Ne re-render que si l'état ou le contexte a changé
        const shouldRerender = previousState.stateKey !== currentStateKey;
        this.previousRenderState.stateKey = currentStateKey;

        // Toujours mettre à jour les chats en mode DEBATE (pour les nouveaux messages)
        const shouldUpdateDebateChat = this.currentState === 'DEBATE' &&
            (previousState.lawyerMessagesCount !== this.sessionData.lawyerMessages.length ||
                previousState.spectatorMessagesCount !== this.sessionData.spectatorMessages.length);

        this.previousRenderState.lawyerMessagesCount = this.sessionData.lawyerMessages.length;
        this.previousRenderState.spectatorMessagesCount = this.sessionData.spectatorMessages.length;

        // Toujours mettre à jour les votes en mode VOTING (pour les nouveaux votes)
        const shouldUpdateVotes = this.currentState === 'VOTING' &&
            previousState.votesCount !== Object.keys(this.sessionData.votes).length;

        this.previousRenderState.votesCount = Object.keys(this.sessionData.votes).length;

        // Rendu selon l'état (seulement si nécessaire)
        if (shouldRerender) {
            switch (this.currentState) {
                case 'WAITING':
                    this.renderWaitingScreen(mainArea, interactionArea);
                    break;
                case 'STABILIZING':
                    this.renderStabilizingScreen(mainArea, interactionArea);
                    break;
                case 'COUNTDOWN':
                    this.renderCountdownScreen(mainArea, interactionArea);
                    break;
                case 'QUESTION':
                    this.renderQuestionScreen(mainArea, interactionArea);
                    break;
                case 'DEBATE':
                    this.renderDebateScreen(mainArea, interactionArea);
                    break;
                case 'VOTING':
                    this.renderVotingScreen(mainArea, interactionArea);
                    break;
                case 'RESULT':
                    this.renderResultScreen(mainArea, interactionArea);
                    break;
            }
        } else if (shouldUpdateDebateChat) {
            // Mise à jour légère : seulement les messages
            this.updateDebateMessages();
        } else if (shouldUpdateVotes) {
            // Mise à jour légère : seulement les votes
            this.updateVoteCounts();
        }
    }

    // ============================================
    // MISES À JOUR LÉGÈRES (sans re-render complet)
    // ============================================

    updateDebateMessages() {
        const lawyersChat = document.getElementById('lawyersChat');
        const spectatorsChat = document.getElementById('spectatorsChat');

        if (lawyersChat) {
            let messagesHTML = '';
            for (const msg of this.sessionData.lawyerMessages) {
                const isLawyer1 = msg.role === 'lawyer1';
                const lawyerName = isLawyer1 ? 'Avocat 1' : 'Avocat 2';
                const lawyerClass = isLawyer1 ? 'lawyer-1' : 'lawyer-2';

                messagesHTML += `
                    <div class="lawyer-message ${lawyerClass}">
                        <div class="lawyer-name">${lawyerName}</div>
                        <div class="lawyer-text">${msg.content}</div>
                    </div>
                `;
            }
            lawyersChat.innerHTML = messagesHTML || '<p class="no-messages">Aucun message pour le moment...</p>';
            lawyersChat.scrollTop = lawyersChat.scrollHeight;
        }

        if (spectatorsChat) {
            spectatorsChat.innerHTML = this.renderSpectatorMessages();
            spectatorsChat.scrollTop = spectatorsChat.scrollHeight;
        }
    }

    updateVoteCounts() {
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const totalVotes = votes1 + votes2;

        // Mettre à jour les cartes de vote
        const voteCards = document.querySelectorAll('.debate-vote-card');
        if (voteCards.length === 2) {
            // Carte Avocat 1
            voteCards[0].querySelector('.vote-count').textContent = `${votes1} ${votes1 > 1 ? 'votes' : 'vote'}`;
            if (totalVotes > 0) {
                const percent = voteCards[0].querySelector('.vote-percentage');
                if (percent) {
                    percent.textContent = `${Math.round(votes1 / totalVotes * 100)}%`;
                }
            }

            // Carte Avocat 2
            voteCards[1].querySelector('.vote-count').textContent = `${votes2} ${votes2 > 1 ? 'votes' : 'vote'}`;
            if (totalVotes > 0) {
                const percent = voteCards[1].querySelector('.vote-percentage');
                if (percent) {
                    percent.textContent = `${Math.round(votes2 / totalVotes * 100)}%`;
                }
            }
        }

        // Mettre à jour le total
        const voteCount = document.querySelector('.debate-vote-count');
        if (voteCount) {
            voteCount.textContent = `Total : ${totalVotes} ${totalVotes > 1 ? 'votes' : 'vote'}`;
        }
    }
    
    // ============================================
    // HYPE : JAUGE D'INTENSITÉ & POINT DE BASCULE
    // ============================================
    
    renderVoteTensionGauge() {
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const totalVotes = votes1 + votes2;
        
        if (totalVotes === 0) return '';
        
        // Calculer la tension (plus c'est serré, plus c'est tendu)
        const ratio = votes1 / (votes1 + votes2);
        const tension = Math.round((1 - Math.abs(ratio - 0.5) * 2) * 100);
        
        // Nombre de barres pleines sur 10
        const filledBars = Math.round((tension / 100) * 10);
        const bars = '█'.repeat(filledBars) + '░'.repeat(10 - filledBars);
        
        // Couleur selon la tension
        let tensionClass = 'low';
        let tensionText = 'Tranquille';
        if (tension > 70) {
            tensionClass = 'extreme';
            tensionText = 'Extrême ! 🔥';
        } else if (tension > 50) {
            tensionClass = 'high';
            tensionText = 'Intense !';
        } else if (tension > 30) {
            tensionClass = 'medium';
            tensionText = 'Modérée';
        }
        
        return `
            <div class="debate-tension-gauge tension-${tensionClass}">
                <div class="tension-label">
                    <span class="tension-icon">⚡</span>
                    <span>Intensité : ${tensionText}</span>
                </div>
                <div class="tension-bar-container">
                    <div class="tension-bar-bg">${bars}</div>
                    <div class="tension-percentage">${tension}%</div>
                </div>
            </div>
        `;
    }
    
    checkAndAnnounceLeaderChange() {
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        
        // Stocker le leader précédent
        if (!this.previousLeader) {
            this.previousLeader = votes1 > votes2 ? 'lawyer1' : votes2 > votes1 ? 'lawyer2' : null;
            return;
        }
        
        const currentLeader = votes1 > votes2 ? 'lawyer1' : votes2 > votes1 ? 'lawyer2' : null;
        
        // Si changement de leader
        if (currentLeader && currentLeader !== this.previousLeader) {
            const lawyerName = currentLeader === 'lawyer1' ? 'Avocat 1' : 'Avocat 2';
            
            // Toast flash
            this.showDebateToast(`🔄 ${lawyerName} reprend l'avantage !`, 'info');
            
            // Son si disponible
            if (this.audio) {
                this.audio.playSound('setPostIt');
            }
            
            // Animation flash
            const mainArea = document.getElementById('debateMainArea');
            if (mainArea) {
                mainArea.classList.add('leader-change-flash');
                setTimeout(() => {
                    mainArea.classList.remove('leader-change-flash');
                }, 500);
            }
            
            this.previousLeader = currentLeader;
        }
    }

    // ============================================
    // RENDUS D'ÉCRANS
    // ============================================

    renderWaitingScreen(mainArea, interactionArea) {
        const count = this.sessionData.participants?.length || 0;

        mainArea.innerHTML = `
            <div class="debate-waiting-screen">
                <div class="debate-waiting-icon">⏳</div>
                <h2>Salle d'attente</h2>
                <p class="debate-player-count">
                    <span class="big-number">${count}</span> / 4 joueurs minimum
                </p>
                <div class="debate-progress-bar">
                    <div class="debate-progress-fill" style="width: ${Math.min(count / 4 * 100, 100)}%"></div>
                </div>
                <p class="debate-waiting-hint">
                    ${count >= 4 ? '✅ Démarrage dans quelques secondes...' : '⏱️ En attente de joueurs...'}
                </p>
                <div class="debate-info-text" style="margin-top: 24px;">
                    <p>🎭 <strong>Comment ça marche ?</strong></p>
                    <p style="font-size: 14px; margin-top: 8px;">
                        • 1 Décisionnaire choisit la question<br>
                        • 2 Avocats débattent pendant 60s<br>
                        • Les spectateurs votent pour le meilleur !
                    </p>
                </div>
            </div>
        `;

        interactionArea.innerHTML = '';
    }

    renderStabilizingScreen(mainArea, interactionArea) {
        const count = this.sessionData.participants?.length || 0;

        mainArea.innerHTML = `
            <div class="debate-stabilizing-screen">
                <div class="debate-spinner">🔄</div>
                <h2>Vérification des joueurs...</h2>
                <p>${count} joueurs prêts</p>
            </div>
        `;

        interactionArea.innerHTML = '';
    }

    renderCountdownScreen(mainArea, interactionArea) {
        const remaining = Math.max(0, this.config.countdownTime - (Date.now() - this.sessionData.stateStartTime));
        const countdownNum = Math.ceil(remaining / 1000);

        mainArea.innerHTML = `
            <div class="debate-countdown-screen">
                <div class="debate-countdown-number">${countdownNum}</div>
                <h2>Préparez-vous !</h2>
                <p>Les rôles vont être attribués...</p>
            </div>
        `;

        interactionArea.innerHTML = '';
    }

    renderQuestionScreen(mainArea, interactionArea) {
        const hasQuestion = !!this.sessionData.question;

        mainArea.innerHTML = `
            <div class="debate-question-screen">
                <div class="debate-phase-banner">
                    <span class="phase-icon">❓</span>
                    <span class="phase-text">Phase de Question</span>
                </div>
                
                ${hasQuestion ? `
                    <div class="debate-question-display">
                        <h3>Question choisie :</h3>
                        <p class="debate-question-text">${this.sessionData.question}</p>
                        <p class="debate-hint">⏱️ Le débat commence bientôt...</p>
                    </div>
                ` : `
                    <div class="debate-question-waiting">
                        <div class="debate-hourglass">⏳</div>
                        <h3>En attente de la question...</h3>
                        <p>Le décisionnaire choisit le sujet du débat</p>
                    </div>
                `}
            </div>
        `;

        // Zone d'interaction : seul le décisionnaire peut écrire
        if (this.myRole === 'decisionnaire' && !hasQuestion) {
            interactionArea.innerHTML = `
                <div class="debate-question-input-zone">
                    <h4>⚖️ Tu es le Décisionnaire !</h4>
                    <p>Choisis une question pour le débat :</p>
                    <div class="debate-input-container">
                        <input 
                            type="text" 
                            id="questionInput" 
                            class="debate-input" 
                            placeholder="Ex: Les chats sont-ils meilleurs que les chiens ?"
                            maxlength="120"
                        >
                        <button class="debate-submit-btn" id="submitQuestionBtn">
                            Valider
                        </button>
                    </div>
                    <p class="debate-hint" style="margin-top: 8px;">
                        💡 Pose une question qui crée le débat !
                    </p>
                </div>
            `;

            document.getElementById('submitQuestionBtn')?.addEventListener('click', () => {
                const input = document.getElementById('questionInput');
                if (input) {
                    this.submitQuestion(input.value);
                }
            });

            document.getElementById('questionInput')?.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const input = document.getElementById('questionInput');
                    if (input) {
                        this.submitQuestion(input.value);
                    }
                }
            });
        } else if (hasQuestion) {
            interactionArea.innerHTML = `
                <div class="debate-info-box success">
                    ✅ Question validée ! Le débat va commencer...
                </div>
            `;
        } else {
            interactionArea.innerHTML = `
                <div class="debate-info-box">
                    ⏳ En attente du décisionnaire...
                </div>
            `;
        }
    }

    renderDebateScreen(mainArea, interactionArea) {
        // Afficher la question
        let messagesHTML = '';

        // Messages des avocats
        for (const msg of this.sessionData.lawyerMessages) {
            const isLawyer1 = msg.role === 'lawyer1';
            const lawyerName = isLawyer1 ? 'Avocat 1' : 'Avocat 2';
            const lawyerClass = isLawyer1 ? 'lawyer-1' : 'lawyer-2';

            messagesHTML += `
                <div class="lawyer-message ${lawyerClass}">
                    <div class="lawyer-name">${lawyerName}</div>
                    <div class="lawyer-text">${msg.content}</div>
                </div>
            `;
        }

        mainArea.innerHTML = `
            <div class="debate-active-screen">
                <div class="debate-topic-banner">
                    <span class="topic-icon">💬</span>
                    <span class="debate-topic-text">${this.sessionData.question || 'Question en attente...'}</span>
                </div>
                
                <div class="debate-lawyers-zone">
                    <h4 class="lawyers-title">🎙️ Zone des Avocats</h4>
                    <div class="lawyers-chat" id="lawyersChat">
                        ${messagesHTML || '<p class="no-messages">Aucun message pour le moment...</p>'}
                    </div>
                </div>
                
                <div class="debate-spectators-zone" id="spectatorsZone">
                    <h4 class="spectators-title">👁️ Chat des Spectateurs</h4>
                    <div class="spectators-chat" id="spectatorsChat">
                        ${this.renderSpectatorMessages()}
                    </div>
                </div>
            </div>
        `;

        // Auto-scroll des chats
        setTimeout(() => {
            const lawyersChat = document.getElementById('lawyersChat');
            const spectatorsChat = document.getElementById('spectatorsChat');
            if (lawyersChat) lawyersChat.scrollTop = lawyersChat.scrollHeight;
            if (spectatorsChat) spectatorsChat.scrollTop = spectatorsChat.scrollHeight;
        }, 100);

        // Zone d'interaction selon le rôle
        if (this.myRole === 'lawyer1' || this.myRole === 'lawyer2') {
            interactionArea.innerHTML = `
                <div class="debate-lawyer-input-zone">
                    <p class="input-label">👔 Défends ta position :</p>
                    <div class="debate-input-container">
                        <input 
                            type="text" 
                            id="lawyerMessageInput" 
                            class="debate-input" 
                            placeholder="Tape ton argument..."
                            maxlength="200"
                        >
                        <button class="debate-submit-btn" id="sendLawyerMessageBtn">
                            Envoyer
                        </button>
                    </div>
                </div>
            `;

            document.getElementById('sendLawyerMessageBtn')?.addEventListener('click', () => {
                const input = document.getElementById('lawyerMessageInput');
                if (input && input.value.trim()) {
                    this.sendLawyerMessage(input.value);
                    input.value = '';
                }
            });

            document.getElementById('lawyerMessageInput')?.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const input = document.getElementById('lawyerMessageInput');
                    if (input && input.value.trim()) {
                        this.sendLawyerMessage(input.value);
                        input.value = '';
                    }
                }
            });
        } else if (this.myRole === 'spectator') {
            interactionArea.innerHTML = `
                <div class="debate-spectator-input-zone">
                    <p class="input-label">👁️ Commente le débat :</p>
                    <div class="debate-input-container">
                        <input 
                            type="text" 
                            id="spectatorMessageInput" 
                            class="debate-input" 
                            placeholder="Ton avis..."
                            maxlength="150"
                        >
                        <button class="debate-submit-btn" id="sendSpectatorMessageBtn">
                            Envoyer
                        </button>
                    </div>
                </div>
            `;

            document.getElementById('sendSpectatorMessageBtn')?.addEventListener('click', () => {
                const input = document.getElementById('spectatorMessageInput');
                if (input && input.value.trim()) {
                    this.sendSpectatorMessage(input.value);
                    input.value = '';
                }
            });

            document.getElementById('spectatorMessageInput')?.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const input = document.getElementById('spectatorMessageInput');
                    if (input && input.value.trim()) {
                        this.sendSpectatorMessage(input.value);
                        input.value = '';
                    }
                }
            });
        } else {
            interactionArea.innerHTML = `
                <div class="debate-info-box">
                    ⚖️ Tu es le décisionnaire - observe le débat !
                </div>
            `;
        }
    }

    renderSpectatorMessages() {
        if (this.sessionData.spectatorMessages.length === 0) {
            return '<p class="no-messages">Aucun commentaire...</p>';
        }

        let html = '';
        for (const msg of this.sessionData.spectatorMessages) {
            const isMe = msg.userId === this.userId;
            html += `
                <div class="spectator-message ${isMe ? 'my-message' : ''}">
                    <span class="spectator-text">${msg.content}</span>
                </div>
            `;
        }
        return html;
    }

    renderVotingScreen(mainArea, interactionArea) {
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const totalVotes = votes1 + votes2;
        const hasVoted = !!this.sessionData.votes[this.userId];

        mainArea.innerHTML = `
            <div class="debate-voting-screen">
                ${this.renderVoteTensionGauge()}
                
                <h2>🗳️ À toi de voter !</h2>
                <p class="debate-question-reminder">Question : ${this.sessionData.question}</p>
                
                <div class="debate-vote-options">
                    <div class="debate-vote-card ${this.sessionData.votes[this.userId] === 'lawyer1' ? 'voted' : ''}">
                        <div class="vote-lawyer-name">👔 Avocat 1</div>
                        <div class="vote-count">${votes1} ${votes1 > 1 ? 'votes' : 'vote'}</div>
                        ${totalVotes > 0 ? `<div class="vote-percentage">${Math.round(votes1 / totalVotes * 100)}%</div>` : ''}
                    </div>
                    
                    <div class="debate-vote-card ${this.sessionData.votes[this.userId] === 'lawyer2' ? 'voted' : ''}">
                        <div class="vote-lawyer-name">👔 Avocat 2</div>
                        <div class="vote-count">${votes2} ${votes2 > 1 ? 'votes' : 'vote'}</div>
                        ${totalVotes > 0 ? `<div class="vote-percentage">${Math.round(votes2 / totalVotes * 100)}%</div>` : ''}
                    </div>
                </div>
                
                <p class="debate-vote-count">Total : ${totalVotes} ${totalVotes > 1 ? 'votes' : 'vote'}</p>
            </div>
        `;

        // Zone d'interaction : seuls les spectateurs peuvent voter
        if (this.myRole === 'spectator') {
            if (hasVoted) {
                interactionArea.innerHTML = `
                    <div class="debate-info-box success">
                        ✅ Vote enregistré !
                    </div>
                `;
            } else {
                interactionArea.innerHTML = `
                    <div class="debate-vote-buttons">
                        <button class="debate-vote-btn lawyer1" id="voteLawyer1Btn">
                            <span class="vote-icon">👔</span>
                            Voter Avocat 1
                        </button>
                        <button class="debate-vote-btn lawyer2" id="voteLawyer2Btn">
                            <span class="vote-icon">👔</span>
                            Voter Avocat 2
                        </button>
                    </div>
                `;

                document.getElementById('voteLawyer1Btn')?.addEventListener('click', () => {
                    this.submitVote('lawyer1');
                });

                document.getElementById('voteLawyer2Btn')?.addEventListener('click', () => {
                    this.submitVote('lawyer2');
                });
            }
        } else {
            interactionArea.innerHTML = `
                <div class="debate-info-box">
                    ⏳ En attente des votes des spectateurs...
                </div>
            `;
        }
    }

    renderResultScreen(mainArea, interactionArea) {
        const forfeitReason = this.sessionData.forfeitReason || null;
        
        // --- Écran de forfait (déconnexion d'un avocat) ---
        if (forfeitReason) {
            const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
            const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
            const winner = votes1 > votes2 ? 'lawyer1' : votes2 > votes1 ? 'lawyer2' : null;
            const winnerName = winner === 'lawyer1' ? 'Avocat 1' : winner === 'lawyer2' ? 'Avocat 2' : null;
            
            mainArea.innerHTML = `
                <div class="debate-result-screen forfeit">
                    <div class="debate-result-icon">🏳️</div>
                    <h2 class="debate-result-title" style="color: var(--danger, #e74c3c);">Partie interrompue</h2>
                    <p class="debate-forfeit-reason" style="
                        background: rgba(231,76,60,0.1);
                        border: 1px solid rgba(231,76,60,0.3);
                        border-radius: 12px;
                        padding: 12px 20px;
                        margin: 16px 0;
                        font-size: 15px;
                        color: var(--text-primary, #fff);
                    ">⚠️ ${forfeitReason}</p>
                    ${winnerName ? `
                        <div class="debate-forfeit-winner" style="margin-top: 16px;">
                            <div class="debate-result-icon">🏆</div>
                            <p style="font-size: 18px; font-weight: bold; margin: 8px 0;">${winnerName} gagne par forfait !</p>
                        </div>
                    ` : '<p style="font-size: 16px; margin-top: 8px;">Aucun vainqueur déclaré.</p>'}
                    <p class="debate-return-info" style="margin-top: 20px; opacity: 0.6;">
                        Retour au lobby dans quelques secondes...
                    </p>
                </div>
            `;
            interactionArea.innerHTML = '';
            return;
        }
        
        // --- Écran de résultat normal ---
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const totalVotes = votes1 + votes2;

        let winner = null;
        let winnerName = '';

        if (votes1 > votes2) {
            winner = 'lawyer1';
            winnerName = 'Avocat 1';
        } else if (votes2 > votes1) {
            winner = 'lawyer2';
            winnerName = 'Avocat 2';
        } else {
            winnerName = 'Égalité !';
        }

        mainArea.innerHTML = `
            <div class="debate-result-screen">
                <div class="debate-result-icon">${winner ? '🏆' : '🤝'}</div>
                <h2 class="debate-result-title">${winner ? winnerName + ' gagne !' : 'Match nul !'}</h2>
                
                <div class="debate-result-stats">
                    <div class="result-stat ${winner === 'lawyer1' ? 'winner' : ''}">
                        <div class="stat-name">👔 Avocat 1</div>
                        <div class="stat-value">${votes1}</div>
                        ${totalVotes > 0 ? `<div class="stat-percent">${Math.round(votes1 / totalVotes * 100)}%</div>` : ''}
                    </div>
                    
                    <div class="result-separator">VS</div>
                    
                    <div class="result-stat ${winner === 'lawyer2' ? 'winner' : ''}">
                        <div class="stat-name">👔 Avocat 2</div>
                        <div class="stat-value">${votes2}</div>
                        ${totalVotes > 0 ? `<div class="stat-percent">${Math.round(votes2 / totalVotes * 100)}%</div>` : ''}
                    </div>
                </div>
                
                <p class="debate-result-total">
                    ${totalVotes} ${totalVotes > 1 ? 'spectateurs ont voté' : 'spectateur a voté'}
                </p>
                
                <p class="debate-return-info">
                    Retour au lobby dans quelques secondes...
                </p>
            </div>
        `;

        interactionArea.innerHTML = '';
    }

    // ============================================
    // UTILITAIRES
    // ============================================

    escapeHTML(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showDebateToast(message, type = 'info') {
        if (window.app && window.app.showToast) {
            window.app.showToast(message, type);
        }
    }
}

window.DebateModule = DebateModule;
