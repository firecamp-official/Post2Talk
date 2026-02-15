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
            minPlayers: 4,           // Min : 1 décisionnaire + 2 avocats + 1 spectateur
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
        
        this.init();
    }
    
    async init() {
        console.log('🎭 [DEBATE] Initialisation module débat avec rôles...');
        
        this.createUI();
        this.createDebateBadge();
        this.setupEventListeners();
        this.startGlobalHeartbeat();
        
        console.log('✅ [DEBATE] Module initialisé');
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
    // HEARTBEAT GLOBAL
    // ============================================
    
    startGlobalHeartbeat() {
        setInterval(async () => {
            try {
                // Récupérer la session active
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
                    this.myRole = null;
                } else {
                    // Session active trouvée
                    const session = sessions[0];
                    this.currentSessionId = session.id;
                    this.currentState = session.state;
                    
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
                    
                    // Déterminer mon rôle
                    this.updateMyRole();
                }
                
                // Mettre à jour le badge
                this.updateBadge();
                
                // Si la modale est ouverte, mettre à jour l'UI
                if (this.isActive) {
                    this.updateUI();
                    await this.checkStateProgression();
                }
                
            } catch (error) {
                console.error('[DEBATE] Erreur heartbeat:', error);
            }
        }, 1000);
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
    // PROGRESSION D'ÉTAT
    // ============================================
    
    async checkStateProgression() {
        const count = this.sessionData.participants?.length || 0;
        const elapsed = Date.now() - this.sessionData.stateStartTime;
        
        switch (this.currentState) {
            case 'WAITING':
                if (count >= this.config.minPlayers) {
                    await this.transitionToState('STABILIZING');
                }
                break;
                
            case 'STABILIZING':
                if (elapsed >= this.config.stabilizationTime) {
                    await this.transitionToState('COUNTDOWN');
                }
                break;
                
            case 'COUNTDOWN':
                if (elapsed >= this.config.countdownTime) {
                    // Attribuer les rôles et passer à QUESTION
                    await this.assignRoles();
                    await this.transitionToState('QUESTION');
                }
                break;
                
            case 'QUESTION':
                if (elapsed >= this.config.questionTime) {
                    // Si pas de question, utiliser une par défaut
                    if (!this.sessionData.question) {
                        await this.setDefaultQuestion();
                    }
                    await this.transitionToState('DEBATE');
                }
                break;
                
            case 'DEBATE':
                if (elapsed >= this.config.debateTime) {
                    await this.transitionToState('VOTING');
                }
                break;
                
            case 'VOTING':
                if (elapsed >= this.config.votingTime) {
                    await this.transitionToState('RESULT');
                }
                break;
                
            case 'RESULT':
                if (elapsed >= this.config.resultTime) {
                    await this.endSession();
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
        console.log('[DEBATE] Fin de la session');
        
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    is_active: false
                })
                .eq('id', this.currentSessionId);
            
            this.currentSessionId = null;
            this.currentState = 'WAITING';
            this.myRole = null;
            
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
            this.showDebateToast('Attends un peu avant d\'écrire à nouveau', 'warning');
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
        
        this.sessionData.lawyerMessages.push(newMessage);
        
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
            this.showDebateToast('Attends un peu avant d\'écrire à nouveau', 'warning');
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
        
        this.sessionData.spectatorMessages.push(newMessage);
        
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
        } catch (error) {
            console.error('[DEBATE] Erreur vote:', error);
        }
    }
    
    // ============================================
    // OUVERTURE/FERMETURE
    // ============================================
    
    async openDebateModule() {
        console.log('[DEBATE] Ouverture du module');
        
        // Si pas de session active, en créer une
        if (!this.currentSessionId) {
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
                console.log('[DEBATE] ✅ Session créée');
            } catch (error) {
                console.error('[DEBATE] Erreur création:', error);
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
                    
                    console.log('[DEBATE] ✅ Session rejointe');
                } catch (error) {
                    console.error('[DEBATE] Erreur rejoindre:', error);
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
        
        switch (this.currentState) {
            case 'WAITING':
                badge.classList.add('waiting');
                text.textContent = 'Lobby';
                break;
            case 'STABILIZING':
            case 'COUNTDOWN':
                badge.classList.add('stabilizing');
                text.textContent = 'Démarrage...';
                break;
            case 'QUESTION':
            case 'DEBATE':
                badge.classList.add('active');
                text.textContent = '🔴 LIVE';
                break;
            case 'VOTING':
                badge.classList.add('voting');
                text.textContent = 'Vote';
                break;
            case 'RESULT':
                badge.classList.add('active');
                text.textContent = 'Résultat';
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
        
        // Rendu selon l'état
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
