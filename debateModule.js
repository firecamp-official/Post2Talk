// ============================================
// DEBATE MODULE - Real-time Anonymous Debates
// ============================================
// État-machine: WAITING → STABILIZING → COUNTDOWN → TOPIC → DEBATE → VOTING → RESULT
// Système temps réel multi-joueurs avec rôles dynamiques

class DebateModule {
    constructor(supabaseClient, audioManager) {
        this.client = supabaseClient;
        this.audio = audioManager;
        this.userId = this.client.getUserId();
        
        // État actuel
        this.currentState = 'WAITING';
        this.currentSessionId = null;
        this.myRole = 'spectator'; // spectator, lawyer, judge
        
        // Configuration
        this.config = {
            minPlayers: 4,
            stabilizationTime: 5000, // 5 secondes
            countdownTime: 5000,     // 5 secondes
            topicTime: 30000,        // 30 secondes
            debateTime: 60000,       // 60 secondes
            votingTime: 30000,       // 30 secondes
            resultTime: 15000        // 15 secondes
        };
        
        // Données de session
        this.sessionData = {
            participants: [],
            lawyer1: null,
            lawyer2: null,
            judge: null,
            topic: '',
            messages: [],
            votes: {},
            startTime: null
        };
        
        // Timers et intervals
        this.timers = {
            state: null,
            heartbeat: null,
            stabilization: null,
            countdown: null
        };
        
        // Sujets prédéfinis
        this.defaultTopics = [
            "Ananas sur la pizza : pour ou contre ?",
            "Chats vs chiens : qui est le meilleur animal ?",
            "Faut-il bannir les devoirs à la maison ?",
            "Vivre en ville ou à la campagne ?",
            "La pineapple appartient-elle à la pizza ?",
            "Faut-il dormir avec ou sans chaussettes ?",
            "Le pain au chocolat ou chocolatine ?",
            "Mieux vaut être riche ou célèbre ?",
            "Les super-héros sont-ils surestimés ?",
            "Faut-il abolir les lundis ?"
        ];
        
        // Cooldowns
        this.lastMessageTime = 0;
        this.messageCooldown = 3000; // 3 secondes entre messages
        
        // État du module
        this.isActive = false;
        this.isInitialized = false;
        
        this.init();
    }
    
    // ============================================
    // INITIALISATION
    // ============================================
    
    async init() {
        console.log('🎭 Initialisation du module Débat...');
        
        // Créer l'interface
        this.createUI();
        
        // Créer le badge dans le header
        this.createDebateBadge();
        
        // Setup des événements
        this.setupEventListeners();
        
        // Vérifier si une session existe
        await this.checkExistingSession();
        
        // Démarrer le heartbeat
        this.startHeartbeat();
        
        this.isInitialized = true;
        console.log('✅ Module Débat initialisé');
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
        
        this.updateBadge();
    }
    
    createUI() {
        const modalHTML = `
            <div class="modal debate-module-modal" id="debateModuleModal">
                <div class="debate-module-container">
                    <!-- Close button -->
                    <button class="debate-close-btn" id="closeDebateModule">✖</button>
                    
                    <!-- Header avec état et timer -->
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
                    
                    <!-- Zone principale (change selon l'état) -->
                    <div class="debate-main-area" id="debateMainArea">
                        <!-- Contenu dynamique selon l'état -->
                    </div>
                    
                    <!-- Zone d'interaction (input, votes, etc.) -->
                    <div class="debate-interaction-area" id="debateInteractionArea">
                        <!-- Contenu dynamique selon le rôle -->
                    </div>
                    
                    <!-- Footer avec infos -->
                    <div class="debate-footer">
                        <div class="debate-role-badge" id="debateRoleBadge">
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
        // Bouton fermer
        document.getElementById('closeDebateModule')?.addEventListener('click', () => {
            this.closeDebateModule();
        });
        
        // Fermer sur fond
        document.getElementById('debateModuleModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'debateModuleModal') {
                this.closeDebateModule();
            }
        });
        
        // Prévenir double onglet
        window.addEventListener('beforeunload', () => {
            if (this.isActive) {
                this.leaveSession();
            }
        });
    }
    
    // ============================================
    // GESTION SESSION
    // ============================================
    
    async checkExistingSession() {
        if (!this.client.isInitialized) return;
        
        try {
            const { data, error } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('is_active', true)
                .single();
            
            if (error || !data) {
                console.log('Aucune session active');
                this.currentState = 'WAITING';
                return;
            }
            
            // Session existe
            this.currentSessionId = data.id;
            this.currentState = data.state;
            this.sessionData = JSON.parse(data.data || '{}');
            
            console.log('📡 Session trouvée:', data.state);
            this.updateBadge();
            
        } catch (error) {
            console.error('Erreur vérification session:', error);
        }
    }
    
    async createSession() {
        if (!this.client.isInitialized) return null;
        
        try {
            const sessionData = {
                state: 'STABILIZING',
                is_active: true,
                data: JSON.stringify({
                    participants: [this.userId],
                    startTime: Date.now()
                }),
                created_at: new Date().toISOString()
            };
            
            const { data, error } = await this.client.client
                .from('debate_sessions')
                .insert(sessionData)
                .select()
                .single();
            
            if (error) throw error;
            
            this.currentSessionId = data.id;
            this.currentState = 'STABILIZING';
            
            console.log('✅ Session créée:', data.id);
            return data;
            
        } catch (error) {
            console.error('Erreur création session:', error);
            return null;
        }
    }
    
    async joinSession() {
        if (!this.currentSessionId || !this.client.isInitialized) return false;
        
        try {
            // Récupérer la session
            const { data: session, error } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('id', this.currentSessionId)
                .single();
            
            if (error || !session) return false;
            
            const sessionData = JSON.parse(session.data || '{}');
            
            // Ajouter l'utilisateur
            if (!sessionData.participants) sessionData.participants = [];
            if (!sessionData.participants.includes(this.userId)) {
                sessionData.participants.push(this.userId);
            }
            
            // Mettre à jour
            await this.client.client
                .from('debate_sessions')
                .update({
                    data: JSON.stringify(sessionData)
                })
                .eq('id', this.currentSessionId);
            
            this.sessionData = sessionData;
            this.isActive = true;
            
            console.log('✅ Rejoint session:', this.currentSessionId);
            return true;
            
        } catch (error) {
            console.error('Erreur rejoindre session:', error);
            return false;
        }
    }
    
    async leaveSession() {
        if (!this.currentSessionId || !this.isActive) return;
        
        try {
            const { data: session } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('id', this.currentSessionId)
                .single();
            
            if (session) {
                const sessionData = JSON.parse(session.data || '{}');
                sessionData.participants = (sessionData.participants || [])
                    .filter(id => id !== this.userId);
                
                await this.client.client
                    .from('debate_sessions')
                    .update({
                        data: JSON.stringify(sessionData)
                    })
                    .eq('id', this.currentSessionId);
            }
            
            this.isActive = false;
            console.log('👋 Quitté la session');
            
        } catch (error) {
            console.error('Erreur quitter session:', error);
        }
    }
    
    // ============================================
    // MACHINE À ÉTATS
    // ============================================
    
    async transitionTo(newState) {
        console.log(`🔄 Transition: ${this.currentState} → ${newState}`);
        
        const oldState = this.currentState;
        this.currentState = newState;
        
        // Nettoyer les timers de l'ancien état
        this.clearStateTimers();
        
        // Mettre à jour la session
        await this.updateSessionState(newState);
        
        // Gérer le nouvel état
        switch (newState) {
            case 'WAITING':
                this.handleWaitingState();
                break;
            case 'STABILIZING':
                this.handleStabilizingState();
                break;
            case 'COUNTDOWN':
                this.handleCountdownState();
                break;
            case 'TOPIC_SELECTION':
                this.handleTopicSelectionState();
                break;
            case 'DEBATE':
                this.handleDebateState();
                break;
            case 'VOTING':
                this.handleVotingState();
                break;
            case 'RESULT':
                this.handleResultState();
                break;
        }
        
        // Mettre à jour l'UI
        this.renderCurrentState();
        this.updateBadge();
        
        // Son de transition
        if (this.audio) {
            this.audio.playSound('setPostIt');
        }
    }
    
    clearStateTimers() {
        Object.keys(this.timers).forEach(key => {
            if (this.timers[key]) {
                clearTimeout(this.timers[key]);
                clearInterval(this.timers[key]);
                this.timers[key] = null;
            }
        });
    }
    
    async updateSessionState(state) {
        if (!this.currentSessionId || !this.client.isInitialized) return;
        
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    state: state,
                    data: JSON.stringify(this.sessionData)
                })
                .eq('id', this.currentSessionId);
        } catch (error) {
            console.error('Erreur mise à jour état:', error);
        }
    }
    
    // ============================================
    // ÉTATS INDIVIDUELS
    // ============================================
    
    handleWaitingState() {
        console.log('⏳ État: WAITING');
        this.myRole = 'spectator';
        
        // Vérifier régulièrement si assez de joueurs
        this.timers.state = setInterval(() => {
            this.checkCanStartStabilization();
        }, 1000);
    }
    
    async checkCanStartStabilization() {
        const count = this.sessionData.participants?.length || 0;
        
        if (count >= this.config.minPlayers) {
            // Assez de joueurs, démarrer stabilisation
            await this.transitionTo('STABILIZING');
        }
    }
    
    handleStabilizingState() {
        console.log('🔄 État: STABILIZING');
        
        let startTime = Date.now();
        
        this.timers.stabilization = setInterval(async () => {
            const count = this.sessionData.participants?.length || 0;
            
            // Si retombe sous le minimum, reset
            if (count < this.config.minPlayers) {
                await this.transitionTo('WAITING');
                return;
            }
            
            // Si stable depuis 5s, passer au countdown
            if (Date.now() - startTime >= this.config.stabilizationTime) {
                await this.transitionTo('COUNTDOWN');
            }
        }, 500);
    }
    
    handleCountdownState() {
        console.log('⏱️ État: COUNTDOWN');
        
        const endTime = Date.now() + this.config.countdownTime;
        
        this.timers.countdown = setInterval(async () => {
            const remaining = endTime - Date.now();
            
            if (remaining <= 0) {
                // Attribution des rôles et début
                this.assignRoles();
                await this.transitionTo('TOPIC_SELECTION');
            }
        }, 100);
    }
    
    assignRoles() {
        const participants = [...(this.sessionData.participants || [])];
        
        if (participants.length < this.config.minPlayers) {
            console.error('Pas assez de participants pour assigner les rôles');
            return;
        }
        
        // Mélanger
        for (let i = participants.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [participants[i], participants[j]] = [participants[j], participants[i]];
        }
        
        // Assigner
        this.sessionData.lawyer1 = participants[0];
        this.sessionData.lawyer2 = participants[1];
        this.sessionData.judge = participants[2];
        
        // Déterminer mon rôle
        if (this.userId === this.sessionData.lawyer1 || this.userId === this.sessionData.lawyer2) {
            this.myRole = 'lawyer';
        } else if (this.userId === this.sessionData.judge) {
            this.myRole = 'judge';
        } else {
            this.myRole = 'spectator';
        }
        
        console.log('🎭 Rôles assignés:', {
            lawyer1: this.sessionData.lawyer1,
            lawyer2: this.sessionData.lawyer2,
            judge: this.sessionData.judge,
            myRole: this.myRole
        });
    }
    
    handleTopicSelectionState() {
        console.log('📝 État: TOPIC_SELECTION');
        
        const endTime = Date.now() + this.config.topicTime;
        
        this.timers.state = setInterval(async () => {
            const remaining = endTime - Date.now();
            
            if (remaining <= 0) {
                // Si pas de sujet, en choisir un aléatoire
                if (!this.sessionData.topic) {
                    this.sessionData.topic = this.getRandomTopic();
                }
                await this.transitionTo('DEBATE');
            }
        }, 100);
    }
    
    handleDebateState() {
        console.log('💬 État: DEBATE');
        
        // Réinitialiser les messages
        this.sessionData.messages = [];
        
        const endTime = Date.now() + this.config.debateTime;
        
        this.timers.state = setInterval(async () => {
            const remaining = endTime - Date.now();
            
            if (remaining <= 0) {
                await this.transitionTo('VOTING');
            }
        }, 100);
    }
    
    handleVotingState() {
        console.log('🗳️ État: VOTING');
        
        // Réinitialiser les votes
        this.sessionData.votes = {};
        
        const endTime = Date.now() + this.config.votingTime;
        
        this.timers.state = setInterval(async () => {
            const remaining = endTime - Date.now();
            
            if (remaining <= 0) {
                await this.transitionTo('RESULT');
            }
        }, 100);
    }
    
    handleResultState() {
        console.log('🏆 État: RESULT');
        
        this.timers.state = setTimeout(async () => {
            // Retour au lobby
            await this.endSession();
            await this.transitionTo('WAITING');
        }, this.config.resultTime);
    }
    
    async endSession() {
        if (!this.currentSessionId || !this.client.isInitialized) return;
        
        try {
            await this.client.client
                .from('debate_sessions')
                .update({
                    is_active: false
                })
                .eq('id', this.currentSessionId);
            
            this.currentSessionId = null;
            this.sessionData = {
                participants: [],
                lawyer1: null,
                lawyer2: null,
                judge: null,
                topic: '',
                messages: [],
                votes: {}
            };
            
            console.log('✅ Session terminée');
            
        } catch (error) {
            console.error('Erreur fin session:', error);
        }
    }
    
    // ============================================
    // ACTIONS UTILISATEUR
    // ============================================
    
    async submitTopic(topic) {
        if (this.currentState !== 'TOPIC_SELECTION') return;
        if (this.myRole !== 'judge') return;
        
        // Valider
        const validation = ProfanityFilter.validateMessage(topic);
        if (!validation.isValid) {
            this.showDebateToast(validation.reason, 'error');
            return;
        }
        
        if (topic.length > 60) {
            this.showDebateToast('Sujet trop long (max 60 caractères)', 'error');
            return;
        }
        
        this.sessionData.topic = validation.filtered;
        await this.updateSessionState(this.currentState);
        
        this.showDebateToast('Sujet soumis ! ✅', 'success');
        this.renderCurrentState();
    }
    
    async sendMessage(content) {
        if (this.currentState !== 'DEBATE') return;
        if (this.myRole !== 'lawyer') return;
        
        // Vérifier cooldown
        const now = Date.now();
        if (now - this.lastMessageTime < this.messageCooldown) {
            const remaining = Math.ceil((this.messageCooldown - (now - this.lastMessageTime)) / 1000);
            this.showDebateToast(`Attends ${remaining}s avant le prochain message`, 'warning');
            return;
        }
        
        // Valider
        const validation = ProfanityFilter.validateMessage(content);
        if (!validation.isValid) {
            this.showDebateToast(validation.reason, 'error');
            return;
        }
        
        // Enregistrer message
        const message = {
            id: `msg_${Date.now()}_${Math.random()}`,
            userId: this.userId,
            content: validation.filtered,
            timestamp: Date.now()
        };
        
        this.sessionData.messages.push(message);
        this.lastMessageTime = now;
        
        // Sauvegarder
        await this.updateSessionState(this.currentState);
        
        // Mettre à jour l'UI
        this.renderCurrentState();
        
        if (this.audio) {
            this.audio.playSound('addOpinion');
        }
    }
    
    async submitVote(lawyerId) {
        if (this.currentState !== 'VOTING') return;
        if (this.myRole === 'lawyer') return; // Les avocats ne votent pas
        
        // Enregistrer vote
        this.sessionData.votes[this.userId] = lawyerId;
        
        // Sauvegarder
        await this.updateSessionState(this.currentState);
        
        this.showDebateToast('Vote enregistré ! 🗳️', 'success');
        this.renderCurrentState();
        
        if (this.audio) {
            this.audio.playSound('afterVoting');
        }
    }
    
    // ============================================
    // RENDU UI
    // ============================================
    
    renderCurrentState() {
        const mainArea = document.getElementById('debateMainArea');
        const interactionArea = document.getElementById('debateInteractionArea');
        const stateText = document.getElementById('debateStateText');
        const timer = document.getElementById('debateTimer');
        const roleText = document.getElementById('debateRoleText');
        const roleIcon = document.querySelector('.role-icon');
        
        if (!mainArea || !interactionArea) return;
        
        // Mettre à jour le rôle
        switch (this.myRole) {
            case 'lawyer':
                roleText.textContent = 'Avocat';
                roleIcon.textContent = '⚖️';
                break;
            case 'judge':
                roleText.textContent = 'Juge';
                roleIcon.textContent = '⚖️';
                break;
            default:
                roleText.textContent = 'Spectateur';
                roleIcon.textContent = '👤';
        }
        
        // Rendu selon l'état
        switch (this.currentState) {
            case 'WAITING':
                stateText.textContent = 'En attente de joueurs...';
                this.renderWaitingUI(mainArea, interactionArea);
                break;
            case 'STABILIZING':
                stateText.textContent = 'Stabilisation...';
                this.renderStabilizingUI(mainArea, interactionArea);
                break;
            case 'COUNTDOWN':
                stateText.textContent = 'Démarrage imminent !';
                this.renderCountdownUI(mainArea, interactionArea);
                break;
            case 'TOPIC_SELECTION':
                stateText.textContent = 'Choix du sujet';
                this.renderTopicSelectionUI(mainArea, interactionArea);
                break;
            case 'DEBATE':
                stateText.textContent = '💬 Débat en cours';
                this.renderDebateUI(mainArea, interactionArea);
                break;
            case 'VOTING':
                stateText.textContent = '🗳️ Phase de vote';
                this.renderVotingUI(mainArea, interactionArea);
                break;
            case 'RESULT':
                stateText.textContent = '🏆 Résultat';
                this.renderResultUI(mainArea, interactionArea);
                break;
        }
        
        // Démarrer le timer
        this.startTimer();
    }
    
    renderWaitingUI(mainArea, interactionArea) {
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
                    ${count >= 4 ? '✅ Démarrage dès que stable...' : '⏱️ En attente de joueurs...'}
                </p>
            </div>
        `;
        
        interactionArea.innerHTML = `
            <div class="debate-info-box">
                <p>ℹ️ Le débat démarre automatiquement avec 4+ joueurs.</p>
            </div>
        `;
    }
    
    renderStabilizingUI(mainArea, interactionArea) {
        mainArea.innerHTML = `
            <div class="debate-stabilizing-screen">
                <div class="debate-spinner">🔄</div>
                <h2>Vérification des joueurs...</h2>
                <p>Ne quittez pas la page !</p>
            </div>
        `;
        
        interactionArea.innerHTML = '';
    }
    
    renderCountdownUI(mainArea, interactionArea) {
        mainArea.innerHTML = `
            <div class="debate-countdown-screen">
                <div class="debate-countdown-number" id="countdownNumber">5</div>
                <h2>Préparez-vous !</h2>
                <p>Les rôles vont être attribués...</p>
            </div>
        `;
        
        interactionArea.innerHTML = '';
    }
    
    renderTopicSelectionUI(mainArea, interactionArea) {
        const topic = this.sessionData.topic || '';
        
        mainArea.innerHTML = `
            <div class="debate-topic-screen">
                <h2>📝 Sujet du débat</h2>
                ${topic ? `
                    <div class="debate-topic-display">
                        <p class="debate-topic-text">${this.escapeHTML(topic)}</p>
                    </div>
                ` : `
                    <div class="debate-topic-waiting">
                        <p>⏳ Le juge choisit le sujet...</p>
                    </div>
                `}
            </div>
        `;
        
        if (this.myRole === 'judge' && !topic) {
            interactionArea.innerHTML = `
                <div class="debate-input-container">
                    <input 
                        type="text" 
                        id="topicInput" 
                        placeholder="Propose un sujet (max 60 caractères)..."
                        maxlength="60"
                        class="debate-input"
                    />
                    <button class="debate-submit-btn" id="submitTopicBtn">
                        Soumettre
                    </button>
                </div>
            `;
            
            document.getElementById('submitTopicBtn')?.addEventListener('click', () => {
                const input = document.getElementById('topicInput');
                if (input.value.trim()) {
                    this.submitTopic(input.value.trim());
                }
            });
            
            document.getElementById('topicInput')?.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const input = document.getElementById('topicInput');
                    if (input.value.trim()) {
                        this.submitTopic(input.value.trim());
                    }
                }
            });
        } else {
            interactionArea.innerHTML = `
                <div class="debate-info-box">
                    <p>ℹ️ ${this.myRole === 'judge' ? 'Tu as choisi le sujet !' : 'Patiente pendant la sélection du sujet...'}</p>
                </div>
            `;
        }
    }
    
    renderDebateUI(mainArea, interactionArea) {
        const topic = this.sessionData.topic || 'Sujet non défini';
        const messages = this.sessionData.messages || [];
        
        const lawyer1Messages = messages.filter(m => m.userId === this.sessionData.lawyer1);
        const lawyer2Messages = messages.filter(m => m.userId === this.sessionData.lawyer2);
        
        mainArea.innerHTML = `
            <div class="debate-active-screen">
                <div class="debate-topic-banner">
                    ${this.escapeHTML(topic)}
                </div>
                
                <div class="debate-duel-area">
                    <div class="debate-lawyer-column lawyer-1">
                        <div class="lawyer-header">
                            <span class="lawyer-icon">⚖️</span>
                            <span>Avocat 1</span>
                            ${this.userId === this.sessionData.lawyer1 ? '<span class="you-badge">TOI</span>' : ''}
                        </div>
                        <div class="lawyer-messages">
                            ${lawyer1Messages.map(m => `
                                <div class="lawyer-message">
                                    ${this.escapeHTML(m.content)}
                                </div>
                            `).join('') || '<p class="no-messages">Aucun argument...</p>'}
                        </div>
                    </div>
                    
                    <div class="debate-vs">VS</div>
                    
                    <div class="debate-lawyer-column lawyer-2">
                        <div class="lawyer-header">
                            <span class="lawyer-icon">⚖️</span>
                            <span>Avocat 2</span>
                            ${this.userId === this.sessionData.lawyer2 ? '<span class="you-badge">TOI</span>' : ''}
                        </div>
                        <div class="lawyer-messages">
                            ${lawyer2Messages.map(m => `
                                <div class="lawyer-message">
                                    ${this.escapeHTML(m.content)}
                                </div>
                            `).join('') || '<p class="no-messages">Aucun argument...</p>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        if (this.myRole === 'lawyer') {
            interactionArea.innerHTML = `
                <div class="debate-input-container">
                    <textarea 
                        id="messageInput" 
                        placeholder="Ton argument (max 120 caractères)..."
                        maxlength="120"
                        rows="2"
                        class="debate-textarea"
                    ></textarea>
                    <button class="debate-submit-btn" id="sendMessageBtn">
                        Envoyer
                    </button>
                </div>
                <p class="debate-cooldown-hint">⏱️ 3 secondes entre chaque message</p>
            `;
            
            document.getElementById('sendMessageBtn')?.addEventListener('click', () => {
                const input = document.getElementById('messageInput');
                if (input.value.trim()) {
                    this.sendMessage(input.value.trim());
                    input.value = '';
                }
            });
        } else {
            interactionArea.innerHTML = `
                <div class="debate-info-box">
                    <p>👁️ Tu observes le débat en tant que ${this.myRole === 'judge' ? 'juge' : 'spectateur'}</p>
                </div>
            `;
        }
    }
    
    renderVotingUI(mainArea, interactionArea) {
        const topic = this.sessionData.topic || '';
        const votes = this.sessionData.votes || {};
        const myVote = votes[this.userId];
        
        const lawyer1Votes = Object.values(votes).filter(v => v === this.sessionData.lawyer1).length;
        const lawyer2Votes = Object.values(votes).filter(v => v === this.sessionData.lawyer2).length;
        const totalVotes = lawyer1Votes + lawyer2Votes;
        
        mainArea.innerHTML = `
            <div class="debate-voting-screen">
                <div class="debate-topic-banner small">
                    ${this.escapeHTML(topic)}
                </div>
                
                <h2>🗳️ Qui a gagné le débat ?</h2>
                
                <div class="debate-vote-options">
                    <button 
                        class="debate-vote-btn ${myVote === this.sessionData.lawyer1 ? 'voted' : ''}" 
                        id="voteLawyer1Btn"
                        ${this.myRole === 'lawyer' ? 'disabled' : ''}
                    >
                        <div class="vote-lawyer-name">⚖️ Avocat 1</div>
                        <div class="vote-count">${lawyer1Votes} vote${lawyer1Votes > 1 ? 's' : ''}</div>
                        ${totalVotes > 0 ? `
                            <div class="vote-percentage">${Math.round(lawyer1Votes / totalVotes * 100)}%</div>
                        ` : ''}
                    </button>
                    
                    <button 
                        class="debate-vote-btn ${myVote === this.sessionData.lawyer2 ? 'voted' : ''}" 
                        id="voteLawyer2Btn"
                        ${this.myRole === 'lawyer' ? 'disabled' : ''}
                    >
                        <div class="vote-lawyer-name">⚖️ Avocat 2</div>
                        <div class="vote-count">${lawyer2Votes} vote${lawyer2Votes > 1 ? 's' : ''}</div>
                        ${totalVotes > 0 ? `
                            <div class="vote-percentage">${Math.round(lawyer2Votes / totalVotes * 100)}%</div>
                        ` : ''}
                    </button>
                </div>
            </div>
        `;
        
        if (this.myRole !== 'lawyer') {
            document.getElementById('voteLawyer1Btn')?.addEventListener('click', () => {
                this.submitVote(this.sessionData.lawyer1);
            });
            
            document.getElementById('voteLawyer2Btn')?.addEventListener('click', () => {
                this.submitVote(this.sessionData.lawyer2);
            });
            
            interactionArea.innerHTML = myVote ? `
                <div class="debate-info-box success">
                    <p>✅ Vote enregistré !</p>
                </div>
            ` : `
                <div class="debate-info-box">
                    <p>👆 Clique sur un avocat pour voter</p>
                </div>
            `;
        } else {
            interactionArea.innerHTML = `
                <div class="debate-info-box">
                    <p>⚖️ Les avocats ne peuvent pas voter</p>
                </div>
            `;
        }
    }
    
    renderResultUI(mainArea, interactionArea) {
        const votes = this.sessionData.votes || {};
        const lawyer1Votes = Object.values(votes).filter(v => v === this.sessionData.lawyer1).length;
        const lawyer2Votes = Object.values(votes).filter(v => v === this.sessionData.lawyer2).length;
        
        const winner = lawyer1Votes > lawyer2Votes ? 'lawyer1' : 
                       lawyer2Votes > lawyer1Votes ? 'lawyer2' : 'tie';
        
        const totalVotes = lawyer1Votes + lawyer2Votes;
        
        mainArea.innerHTML = `
            <div class="debate-result-screen">
                <h1 class="debate-result-title">
                    ${winner === 'tie' ? '🤝 Égalité !' : '🏆 Victoire !'}
                </h1>
                
                ${winner !== 'tie' ? `
                    <div class="debate-winner-announcement">
                        <p>⚖️ Avocat ${winner === 'lawyer1' ? '1' : '2'} a gagné !</p>
                    </div>
                ` : ''}
                
                <div class="debate-final-scores">
                    <div class="final-score-item ${winner === 'lawyer1' ? 'winner' : ''}">
                        <div class="score-label">Avocat 1</div>
                        <div class="score-value">${lawyer1Votes}</div>
                        <div class="score-percentage">${totalVotes > 0 ? Math.round(lawyer1Votes / totalVotes * 100) : 0}%</div>
                    </div>
                    
                    <div class="final-score-item ${winner === 'lawyer2' ? 'winner' : ''}">
                        <div class="score-label">Avocat 2</div>
                        <div class="score-value">${lawyer2Votes}</div>
                        <div class="score-percentage">${totalVotes > 0 ? Math.round(lawyer2Votes / totalVotes * 100) : 0}%</div>
                    </div>
                </div>
                
                <p class="debate-total-voters">
                    ${totalVotes} votant${totalVotes > 1 ? 's' : ''}
                </p>
                
                <p class="debate-return-info">
                    Retour au lobby dans quelques secondes...
                </p>
            </div>
        `;
        
        interactionArea.innerHTML = '';
    }
    
    // ============================================
    // TIMER
    // ============================================
    
    startTimer() {
        // Nettoyer l'ancien timer
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
        
        this.timerInterval = setInterval(() => {
            this.updateTimer();
        }, 100);
    }
    
    updateTimer() {
        const timerEl = document.getElementById('debateTimer');
        if (!timerEl) return;
        
        let remaining = 0;
        
        switch (this.currentState) {
            case 'COUNTDOWN':
                remaining = this.config.countdownTime - (Date.now() - (this.sessionData.startTime || Date.now()));
                break;
            case 'TOPIC_SELECTION':
                remaining = this.config.topicTime - (Date.now() - (this.sessionData.startTime || Date.now()));
                break;
            case 'DEBATE':
                remaining = this.config.debateTime - (Date.now() - (this.sessionData.startTime || Date.now()));
                break;
            case 'VOTING':
                remaining = this.config.votingTime - (Date.now() - (this.sessionData.startTime || Date.now()));
                break;
            case 'RESULT':
                remaining = this.config.resultTime - (Date.now() - (this.sessionData.startTime || Date.now()));
                break;
            default:
                timerEl.textContent = '--:--';
                return;
        }
        
        remaining = Math.max(0, remaining);
        
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        
        timerEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        // Mise à jour du countdown number
        if (this.currentState === 'COUNTDOWN') {
            const countdownNum = document.getElementById('countdownNumber');
            if (countdownNum) {
                countdownNum.textContent = Math.ceil(remaining / 1000);
            }
        }
    }
    
    // ============================================
    // HEARTBEAT & SYNC
    // ============================================
    
    startHeartbeat() {
        // Vérifier l'état toutes les 2 secondes
        this.timers.heartbeat = setInterval(async () => {
            if (!this.isActive) return;
            
            await this.syncWithServer();
        }, 2000);
    }
    
    async syncWithServer() {
        if (!this.currentSessionId || !this.client.isInitialized) return;
        
        try {
            const { data: session } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('id', this.currentSessionId)
                .single();
            
            if (!session) return;
            
            // Mettre à jour les données locales
            this.sessionData = JSON.parse(session.data || '{}');
            
            // Si l'état a changé côté serveur
            if (session.state !== this.currentState) {
                await this.transitionTo(session.state);
            } else {
                // Juste rafraîchir l'UI
                this.renderCurrentState();
            }
            
            this.updateBadge();
            
        } catch (error) {
            console.error('Erreur sync:', error);
        }
    }
    
    // ============================================
    // BADGE & OUVERTURE MODULE
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
            case 'TOPIC_SELECTION':
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
    
    async openDebateModule() {
        const modal = document.getElementById('debateModuleModal');
        if (!modal) return;
        
        // Rejoindre ou créer session
        if (!this.currentSessionId) {
            // Vérifier si session existe
            await this.checkExistingSession();
            
            if (!this.currentSessionId) {
                // Créer nouvelle session
                await this.createSession();
            }
        }
        
        // Rejoindre
        await this.joinSession();
        
        // Afficher
        modal.classList.add('active');
        this.renderCurrentState();
        
        if (this.audio) {
            this.audio.playSound('setPostIt');
        }
    }
    
    closeDebateModule() {
        const modal = document.getElementById('debateModuleModal');
        if (modal) {
            modal.classList.remove('active');
        }
        
        // On ne quitte pas vraiment la session, on la ferme juste visuellement
        // L'utilisateur reste dans la session via heartbeat
    }
    
    // ============================================
    // UTILITAIRES
    // ============================================
    
    getRandomTopic() {
        const index = Math.floor(Math.random() * this.defaultTopics.length);
        return this.defaultTopics[index];
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

// Export
window.DebateModule = DebateModule;