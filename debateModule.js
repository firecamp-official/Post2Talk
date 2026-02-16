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
            minPlayers: 4,           // ✅ REMIS À 4 (1 décisionnaire + 2 avocats + 1 spectateur)
            stabilizationTime: 3000,  // 3s pour stabiliser la liste des joueurs
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
        this.progressionCheckInterval = null;
        
        // 💓 Heartbeat pour détecter les joueurs actifs/inactifs
        this.playerHeartbeatInterval = null;
        this.lastHeartbeat = Date.now();

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
        
        // Timer local (1s) pour l'affichage seulement - PAS de requête
        this.timerInterval = setInterval(() => {
            this.updateTimerOnly();
        }, 1000);
        
        // ✅ NOUVEAU : Timer pour vérifier la progression (indépendant de Realtime)
        this.progressionCheckInterval = setInterval(() => {
            if (this.isActive && this.currentSessionId) {
                this.checkStateProgression();
            }
        }, 1000); // Vérifie toutes les secondes
        
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
            }
        } else if (eventType === 'DELETE') {
            // Session supprimée
            this.currentSessionId = null;
            this.currentState = 'WAITING';
            this.sessionData.participants = [];
            this.myRole = null;
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
        this.currentSessionId = session.id;
        this.currentState = session.state;
        
        // ✅ FIX : session.data peut être string OU objet selon la source
        let data;
        if (typeof session.data === 'string') {
            data = JSON.parse(session.data || '{}');
        } else {
            data = session.data || {};
        }
        
        this.sessionData = {
            participants: data.participants || [],
            decisionnaire: data.decisionnaire || null,
            lawyer1: data.lawyer1 || null,
            lawyer2: data.lawyer2 || null,
            spectators: data.spectators || [],
            question: data.question || '',
            lawyerMessages: data.lawyerMessages || [],
            spectatorMessages: data.spectatorMessages || [],
            votes: data.votes || {},
            stateStartTime: data.stateStartTime || Date.now()
        };
        
        this.updateMyRole();
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
        
        if (this.progressionCheckInterval) {
            clearInterval(this.progressionCheckInterval);
            this.progressionCheckInterval = null;
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

        // 🔍 DEBUG
        console.log('[DEBATE] checkStateProgression:', {
            state: this.currentState,
            participants: count,
            minPlayers: this.config.minPlayers,
            elapsed: Math.round(elapsed / 1000) + 's'
        });

        // Système de "leader" : seul le premier participant fait la transition
        // Cela réduit drastiquement les requêtes simultanées
        const isLeader = this.sessionData.participants[0] === this.userId;

        if (!isLeader) {
            // Les non-leaders observent seulement
            console.log('[DEBATE] Pas leader, j\'observe');
            return;
        }

        console.log('[DEBATE] Je suis leader, je gère les transitions');

        // Ajouter un petit délai aléatoire pour éviter les conflits
        const randomDelay = Math.random() * 200;

        switch (this.currentState) {
            case 'WAITING':
                console.log('[DEBATE] État WAITING, participants:', count, '/', this.config.minPlayers);
                if (count >= this.config.minPlayers) {
                    console.log('[DEBATE] ✅ Assez de joueurs ! Lancement...');
                    setTimeout(() => this.transitionToState('STABILIZING'), randomDelay);
                } else {
                    console.log('[DEBATE] ⏳ Pas assez de joueurs encore');
                }
                break;

            case 'STABILIZING':
                if (elapsed >= this.config.stabilizationTime) {
                    setTimeout(() => this.transitionToState('COUNTDOWN'), randomDelay);
                }
                break;

            case 'COUNTDOWN':
                if (elapsed >= this.config.countdownTime) {
                    // Attribuer les rôles et passer à QUESTION
                    setTimeout(async () => {
                        await this.assignRoles();
                        await this.transitionToState('QUESTION');
                    }, randomDelay);
                }
                break;

            case 'QUESTION':
                if (elapsed >= this.config.questionTime) {
                    // Si pas de question, utiliser une par défaut
                    setTimeout(async () => {
                        if (!this.sessionData.question) {
                            await this.setDefaultQuestion();
                        }
                        await this.transitionToState('DEBATE');
                    }, randomDelay);
                }
                break;

            case 'DEBATE':
                if (elapsed >= this.config.debateTime) {
                    setTimeout(() => this.transitionToState('VOTING'), randomDelay);
                }
                break;

            case 'VOTING':
                if (elapsed >= this.config.votingTime) {
                    setTimeout(() => this.transitionToState('RESULT'), randomDelay);
                }
                break;

            case 'RESULT':
                if (elapsed >= this.config.resultTime) {
                    setTimeout(() => this.endSession(), randomDelay);
                }
                break;
        }
    }

    async transitionToState(newState) {
        console.log(`[DEBATE] Transition: ${this.currentState} → ${newState}`);

        this.sessionData.stateStartTime = Date.now();

        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    state: newState,
                    data: JSON.stringify(this.sessionData)
                })
                .eq('id', this.currentSessionId);

            console.log(`[DEBATE] ✅ État changé: ${newState}`);
        } catch (error) {
            console.error('[DEBATE] Erreur transition:', error);
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
                .update({
                    data: JSON.stringify(this.sessionData)
                })
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
                    data: JSON.stringify(this.sessionData)
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
            this.currentSessionId = null;
            this.currentState = 'WAITING';
            this.myRole = null;
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
                stateStartTime: Date.now()
            };

        } catch (error) {
            console.error('[DEBATE] Erreur fin session:', error);
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
                    data: JSON.stringify(this.sessionData)
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
                    data: JSON.stringify(this.sessionData)
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
                    data: JSON.stringify(this.sessionData)
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
                    data: JSON.stringify(this.sessionData)
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
                    const data = JSON.parse(session.data || '{}');
                    const stateStartTime = data.stateStartTime || 0;
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
                    else if (!data.participants || data.participants.length === 0) {
                        shouldClean = true;
                        reason = 'aucun participant';
                    }
                    
                } catch (parseError) {
                    // Si impossible de parser le JSON, c'est une session corrompue
                    shouldClean = true;
                    reason = 'données corrompues';
                }
                
                if (shouldClean) {
                    sessionsToClean.push(session.id);
                    console.log(`[DEBATE] 🧟 Zombie: ${session.id.substring(0, 8)}... (${session.state}, ${reason})`);
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

        // ✅ FIX : CHERCHER d'abord une session active existante
        const { data: existingSessions } = await this.client.client
            .from('debate_sessions')
            .select('*')
            .eq('is_active', true)
            .eq('state', 'WAITING')
            .limit(1);

        if (existingSessions && existingSessions.length > 0) {
            // ✅ REJOINDRE la session existante
            const session = existingSessions[0];
            this.currentSessionId = session.id;
            
            const data = JSON.parse(session.data || '{}');
            this.sessionData = {
                participants: data.participants || [],
                decisionnaire: data.decisionnaire || null,
                lawyer1: data.lawyer1 || null,
                lawyer2: data.lawyer2 || null,
                spectators: data.spectators || [],
                question: data.question || '',
                lawyerMessages: data.lawyerMessages || [],
                spectatorMessages: data.spectatorMessages || [],
                votes: data.votes || {},
                stateStartTime: data.stateStartTime || Date.now()
            };
            
            // Ajouter ce joueur s'il n'est pas déjà dans la liste
            if (!this.sessionData.participants.includes(this.userId)) {
                this.sessionData.participants.push(this.userId);
                
                await this.client.client
                    .from('debate_sessions')
                    .update({
                        data: JSON.stringify(this.sessionData)
                    })
                    .eq('id', this.currentSessionId);
                
                console.log('[DEBATE] ✅ Session rejointe, participants:', this.sessionData.participants.length);
            } else {
                console.log('[DEBATE] ✅ Déjà dans la session');
            }
            
        } else {
            // ✅ CRÉER une nouvelle session seulement si aucune n'existe
            try {
                const { data, error } = await this.client.client
                    .from('debate_sessions')
                    .insert({
                        state: 'WAITING',
                        is_active: true,
                        data: JSON.stringify({
                            participants: [this.userId],
                            decisionnaire: null,
                            lawyer1: null,
                            lawyer2: null,
                            spectators: [],
                            question: '',
                            lawyerMessages: [],
                            spectatorMessages: [],
                            votes: {},
                            stateStartTime: Date.now()
                        })
                    })
                    .select()
                    .single();

                if (error) throw error;

                this.currentSessionId = data.id;
                this.sessionData.participants = [this.userId];
                console.log('[DEBATE] ✅ Nouvelle session créée');
            } catch (error) {
                console.error('[DEBATE] Erreur création:', error);
            }
        }

        this.isActive = true;

        const modal = document.getElementById('debateModuleModal');
        if (modal) {
            modal.classList.add('active');
        }

        this.updateUI();

        if (this.audio) {
            this.audio.playSound('setPostIt');
        }
    }

    closeDebateModule() {
        this.isActive = false;

        const modal = document.getElementById('debateModuleModal');
        if (modal) {
            modal.classList.remove('active');
        }
        
        // Si on ferme pendant WAITING et qu'on est seul, nettoyer la session
        if (this.currentState === 'WAITING' && 
            this.currentSessionId && 
            this.sessionData.participants.length === 1 &&
            this.sessionData.participants[0] === this.userId) {
            
            console.log('[DEBATE] 🧹 Nettoyage session WAITING abandonnée');
            
            // Nettoyer de manière asynchrone (pas d'attente)
            this.client.client
                .from('debate_sessions')
                .update({ is_active: false })
                .eq('id', this.currentSessionId)
                .then(() => {
                    console.log('[DEBATE] ✅ Session WAITING nettoyée');
                    this.currentSessionId = null;
                })
                .catch(err => {
                    console.error('[DEBATE] Erreur nettoyage WAITING:', err);
                });
        }
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
