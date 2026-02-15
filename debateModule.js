// ============================================
// DEBATE MODULE - VERSION SIMPLIFIÉE FONCTIONNELLE
// ============================================
// Cette version fonctionne avec polling simple, pas de leader/observateur complexe

class DebateModule {
    constructor(supabaseClient, audioManager) {
        this.client = supabaseClient;
        this.audio = audioManager;
        this.userId = this.client.getUserId();
        
        // État
        this.currentState = 'WAITING';
        this.currentSessionId = null;
        this.myRole = 'spectator';
        this.isActive = false;
        
        // Configuration (temps réduits pour test)
        this.config = {
            minPlayers: 2,  // Réduit à 2 pour test facile
            stabilizationTime: 3000,  // 3s
            countdownTime: 3000,      // 3s
            topicTime: 15000,         // 15s
            debateTime: 30000,        // 30s
            votingTime: 15000,        // 15s
            resultTime: 10000         // 10s
        };
        
        // Données
        this.sessionData = {
            participants: [],
            lawyer1: null,
            lawyer2: null,
            judge: null,
            topic: '',
            messages: [],
            votes: {},
            stateStartTime: Date.now()
        };
        
        // Sujets
        this.defaultTopics = [
            "Ananas sur la pizza : pour ou contre ?",
            "Chats vs chiens : qui est le meilleur ?",
            "Mieux vaut être riche ou célèbre ?",
            "Le pain au chocolat ou chocolatine ?"
        ];
        
        this.lastMessageTime = 0;
        this.messageCooldown = 3000;
        
        this.init();
    }
    
    async init() {
        console.log('🎭 [SIMPLE] Initialisation module débat...');
        
        this.createUI();
        this.createDebateBadge();
        this.setupEventListeners();
        
        // Démarrer le heartbeat global
        this.startGlobalHeartbeat();
        
        console.log('✅ [SIMPLE] Module initialisé');
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
                <span class="debate-badge-text">Débat</span>
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
                    
                    <div class="debate-header">
                        <div class="debate-state-info">
                            <span class="debate-state-icon">⏳</span>
                            <span class="debate-state-text" id="debateStateText">En attente...</span>
                        </div>
                        <div class="debate-timer" id="debateTimer">--:--</div>
                        <div class="debate-participants-info">
                            <span class="participant-icon">👥</span>
                            <span id="debateParticipantCount">0</span>/2+
                        </div>
                    </div>
                    
                    <div class="debate-main-area" id="debateMainArea">
                        <div class="debate-waiting-screen">
                            <div class="debate-waiting-icon">⏳</div>
                            <h2>Chargement...</h2>
                        </div>
                    </div>
                    
                    <div class="debate-interaction-area" id="debateInteractionArea"></div>
                    
                    <div class="debate-footer">
                        <div class="debate-role-badge">
                            <span class="role-icon">👤</span>
                            <span id="debateRoleText">Spectateur</span>
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
    // HEARTBEAT GLOBAL - SIMPLIFIÉ
    // ============================================
    
    startGlobalHeartbeat() {
        setInterval(async () => {
            try {
                // Toujours vérifier s'il y a une session active
                const { data: sessions } = await this.client.client
                    .from('debate_sessions')
                    .select('*')
                    .eq('is_active', true)
                    .limit(1);
                
                if (!sessions || sessions.length === 0) {
                    // Pas de session active
                    this.currentSessionId = null;
                    this.currentState = 'WAITING';
                    this.sessionData.participants = [];
                } else {
                    // Session active trouvée
                    const session = sessions[0];
                    this.currentSessionId = session.id;
                    this.currentState = session.state;
                    
                    const data = JSON.parse(session.data || '{}');
                    this.sessionData = {
                        participants: data.participants || [],
                        lawyer1: data.lawyer1 || null,
                        lawyer2: data.lawyer2 || null,
                        judge: data.judge || null,
                        topic: data.topic || '',
                        messages: data.messages || [],
                        votes: data.votes || {},
                        stateStartTime: data.stateStartTime || Date.now()
                    };
                }
                
                // Mettre à jour le badge
                this.updateBadge();
                
                // Si la modale est ouverte, mettre à jour l'UI
                if (this.isActive) {
                    this.updateUI();
                    
                    // Gérer la progression d'état (SIMPLE - tous les clients peuvent le faire)
                    await this.checkStateProgression();
                }
                
            } catch (error) {
                console.error('[SIMPLE] Erreur heartbeat:', error);
            }
        }, 1000); // Toutes les secondes
    }
    
    // ============================================
    // PROGRESSION D'ÉTAT SIMPLIFIÉE
    // ============================================
    
    async checkStateProgression() {
        const count = this.sessionData.participants?.length || 0;
        const elapsed = Date.now() - this.sessionData.stateStartTime;
        
        console.log(`[SIMPLE] État: ${this.currentState}, Joueurs: ${count}, Temps: ${Math.floor(elapsed/1000)}s`);
        
        switch (this.currentState) {
            case 'WAITING':
                if (count >= this.config.minPlayers) {
                    console.log('[SIMPLE] ✅ Assez de joueurs, passage STABILIZING');
                    await this.changeState('STABILIZING');
                }
                break;
                
            case 'STABILIZING':
                if (count < this.config.minPlayers) {
                    await this.changeState('WAITING');
                } else if (elapsed >= this.config.stabilizationTime) {
                    console.log('[SIMPLE] ✅ Stabilisation OK, passage COUNTDOWN');
                    await this.changeState('COUNTDOWN');
                }
                break;
                
            case 'COUNTDOWN':
                if (elapsed >= this.config.countdownTime) {
                    console.log('[SIMPLE] ✅ Countdown terminé, attribution rôles');
                    this.assignRoles();
                    await this.changeState('TOPIC_SELECTION');
                }
                break;
                
            case 'TOPIC_SELECTION':
                if (elapsed >= this.config.topicTime) {
                    if (!this.sessionData.topic) {
                        this.sessionData.topic = this.getRandomTopic();
                    }
                    console.log('[SIMPLE] ✅ Sujet choisi, début débat');
                    await this.changeState('DEBATE');
                }
                break;
                
            case 'DEBATE':
                if (elapsed >= this.config.debateTime) {
                    console.log('[SIMPLE] ✅ Débat terminé, passage vote');
                    await this.changeState('VOTING');
                }
                break;
                
            case 'VOTING':
                if (elapsed >= this.config.votingTime) {
                    console.log('[SIMPLE] ✅ Vote terminé, affichage résultat');
                    await this.changeState('RESULT');
                }
                break;
                
            case 'RESULT':
                if (elapsed >= this.config.resultTime) {
                    console.log('[SIMPLE] ✅ Résultat affiché, retour lobby');
                    await this.endSession();
                }
                break;
        }
    }
    
    async changeState(newState) {
        if (newState === this.currentState) return;
        
        console.log(`[SIMPLE] 🔄 ${this.currentState} → ${newState}`);
        
        this.sessionData.stateStartTime = Date.now();
        
        // Réinitialiser selon l'état
        if (newState === 'DEBATE') {
            this.sessionData.messages = [];
        }
        if (newState === 'VOTING') {
            this.sessionData.votes = {};
        }
        
        // Mettre à jour en BDD
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    state: newState,
                    data: JSON.stringify(this.sessionData)
                })
                .eq('id', this.currentSessionId);
            
            this.currentState = newState;
            
        } catch (error) {
            console.error('[SIMPLE] Erreur changeState:', error);
        }
    }
    
    assignRoles() {
        const participants = [...(this.sessionData.participants || [])];
        
        // Mélanger
        for (let i = participants.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [participants[i], participants[j]] = [participants[j], participants[i]];
        }
        
        this.sessionData.lawyer1 = participants[0];
        this.sessionData.lawyer2 = participants[1];
        this.sessionData.judge = participants[2] || participants[0];
        
        // Déterminer mon rôle
        if (this.userId === this.sessionData.lawyer1 || this.userId === this.sessionData.lawyer2) {
            this.myRole = 'lawyer';
        } else if (this.userId === this.sessionData.judge) {
            this.myRole = 'judge';
        } else {
            this.myRole = 'spectator';
        }
        
        console.log('[SIMPLE] 🎭 Mon rôle:', this.myRole);
    }
    
    getRandomTopic() {
        return this.defaultTopics[Math.floor(Math.random() * this.defaultTopics.length)];
    }
    
    async endSession() {
        if (!this.currentSessionId) return;
        
        try {
            await this.client.client
                .from('debate_sessions')
                .update({ is_active: false })
                .eq('id', this.currentSessionId);
            
            this.currentSessionId = null;
            this.currentState = 'WAITING';
            this.sessionData = {
                participants: [],
                lawyer1: null,
                lawyer2: null,
                judge: null,
                topic: '',
                messages: [],
                votes: {},
                stateStartTime: Date.now()
            };
            
        } catch (error) {
            console.error('[SIMPLE] Erreur endSession:', error);
        }
    }
    
    // ============================================
    // OUVERTURE/FERMETURE MODULE
    // ============================================
    
    async openDebateModule() {
        console.log('[SIMPLE] 🎭 Ouverture module...');
        
        // Rejoindre ou créer session
        if (!this.currentSessionId) {
            // Créer nouvelle session
            try {
                const { data, error } = await this.client.client
                    .from('debate_sessions')
                    .insert({
                        state: 'WAITING',
                        is_active: true,
                        data: JSON.stringify({
                            participants: [this.userId],
                            stateStartTime: Date.now()
                        })
                    })
                    .select()
                    .single();
                
                if (!error && data) {
                    this.currentSessionId = data.id;
                    this.sessionData.participants = [this.userId];
                    console.log('[SIMPLE] ✅ Session créée');
                }
            } catch (error) {
                console.error('[SIMPLE] Erreur création:', error);
            }
        } else {
            // Rejoindre session existante
            if (!this.sessionData.participants.includes(this.userId)) {
                this.sessionData.participants.push(this.userId);
                
                try {
                    await this.client.client
                        .from('debate_sessions')
                        .update({
                            data: JSON.stringify(this.sessionData)
                        })
                        .eq('id', this.currentSessionId);
                    
                    console.log('[SIMPLE] ✅ Session rejointe');
                } catch (error) {
                    console.error('[SIMPLE] Erreur rejoindre:', error);
                }
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
        count.textContent = participantCount;
        
        badge.classList.remove('waiting', 'stabilizing', 'active', 'voting');
        
        if (this.currentState === 'WAITING') {
            badge.classList.add('waiting');
            text.textContent = 'Lobby';
        } else if (this.currentState === 'STABILIZING' || this.currentState === 'COUNTDOWN') {
            badge.classList.add('stabilizing');
            text.textContent = 'Démarrage...';
        } else if (this.currentState === 'TOPIC_SELECTION' || this.currentState === 'DEBATE') {
            badge.classList.add('active');
            text.textContent = '🔴 LIVE';
        } else if (this.currentState === 'VOTING') {
            badge.classList.add('voting');
            text.textContent = 'Vote';
        } else if (this.currentState === 'RESULT') {
            badge.classList.add('active');
            text.textContent = 'Résultat';
        }
    }
    
    updateUI() {
        const mainArea = document.getElementById('debateMainArea');
        const participantCountEl = document.getElementById('debateParticipantCount');
        const stateText = document.getElementById('debateStateText');
        const timer = document.getElementById('debateTimer');
        const roleText = document.getElementById('debateRoleText');
        
        if (!mainArea) return;
        
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
                case 'TOPIC_SELECTION': duration = this.config.topicTime; break;
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
        if (roleText) {
            roleText.textContent = this.myRole === 'lawyer' ? 'Avocat' :
                                   this.myRole === 'judge' ? 'Juge' : 'Spectateur';
        }
        
        // Mettre à jour texte d'état
        if (stateText) {
            const stateNames = {
                'WAITING': 'En attente de joueurs...',
                'STABILIZING': 'Stabilisation...',
                'COUNTDOWN': 'Démarrage imminent !',
                'TOPIC_SELECTION': 'Choix du sujet',
                'DEBATE': '💬 Débat en cours',
                'VOTING': '🗳️ Phase de vote',
                'RESULT': '🏆 Résultat'
            };
            stateText.textContent = stateNames[this.currentState] || this.currentState;
        }
        
        // Rendu principal
        const count = this.sessionData.participants?.length || 0;
        
        if (this.currentState === 'WAITING') {
            mainArea.innerHTML = `
                <div class="debate-waiting-screen">
                    <div class="debate-waiting-icon">⏳</div>
                    <h2>Salle d'attente</h2>
                    <p class="debate-player-count">
                        <span class="big-number">${count}</span> / 2 joueurs minimum
                    </p>
                    <div class="debate-progress-bar">
                        <div class="debate-progress-fill" style="width: ${Math.min(count / 2 * 100, 100)}%"></div>
                    </div>
                    <p class="debate-waiting-hint">
                        ${count >= 2 ? '✅ Démarrage dans quelques secondes...' : '⏱️ En attente de joueurs...'}
                    </p>
                </div>
            `;
        } else if (this.currentState === 'STABILIZING') {
            mainArea.innerHTML = `
                <div class="debate-stabilizing-screen">
                    <div class="debate-spinner">🔄</div>
                    <h2>Vérification des joueurs...</h2>
                    <p>${count} joueurs prêts</p>
                </div>
            `;
        } else if (this.currentState === 'COUNTDOWN') {
            const remaining = Math.max(0, this.config.countdownTime - (Date.now() - this.sessionData.stateStartTime));
            const countdownNum = Math.ceil(remaining / 1000);
            mainArea.innerHTML = `
                <div class="debate-countdown-screen">
                    <div class="debate-countdown-number">${countdownNum}</div>
                    <h2>Préparez-vous !</h2>
                    <p>Les rôles vont être attribués...</p>
                </div>
            `;
        } else {
            mainArea.innerHTML = `
                <div class="debate-waiting-screen">
                    <h2>${this.currentState}</h2>
                    <p>État: ${this.myRole}</p>
                    <p>Sujet: ${this.sessionData.topic || 'En attente...'}</p>
                </div>
            `;
        }
    }
    
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
