// ============================================
// DEBATE MODULE — REDESIGN TRIBUNAL
// ============================================
// Tables Supabase utilisées :
//   debate_sessions :
//     id, state, is_active, participants (jsonb[]),
//     decisionnaire, lawyer1, lawyer2,
//     question, lawyer_messages (jsonb[]),
//     spectator_messages (jsonb[]),
//     votes (jsonb{}), state_start_time
// ============================================

class DebateModule {
    constructor(supabaseClient, audioManager) {
        this.client = supabaseClient;
        this.audio = audioManager;
        this.userId = this.client.getUserId();

        // État courant
        this.currentState = 'WAITING';
        this.currentSessionId = null;
        this.myRole = null; // 'decisionnaire' | 'lawyer1' | 'lawyer2' | 'spectator'
        this.isActive = false;
        this.previousLeader = null;
        this.lastParticipantsList = null;
        this.previousRenderState = {};

        // Config temporelle (ms)
        this.config = {
            minPlayers:        4,
            stabilizationTime: 5000,
            countdownTime:     3000,
            questionTime:      30000,
            debateTime:        60000,
            votingTime:        15000,
            resultTime:        10000
        };

        // Données de session
        this.sessionData = {
            participants:      [],
            decisionnaire:     null,
            lawyer1:           null,
            lawyer2:           null,
            spectators:        [],
            question:          '',
            lawyerMessages:    [],
            spectatorMessages: [],
            votes:             {},
            stateStartTime:    Date.now()
        };

        this.lastMessageTime = 0;
        this.messageCooldown = 2000;

        this.realtimeChannel = null;
        this.timerInterval = null;

        this.init();
    }

    // ============================================
    // INITIALISATION
    // ============================================

    async init() {
        console.log('🎭 [DEBATE] Init module débat...');
        this.createUI();
        this.createDebateBadge();
        this.setupEventListeners();
        this.startRealtimeSync();
        console.log('✅ [DEBATE] Prêt');
    }

    // ============================================
    // BADGE HEADER
    // ============================================

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
                <span class="debate-participant-count"></span>
            </div>`;
        badge.addEventListener('click', () => this.openDebateModule());
        header.appendChild(badge);
    }

    // ============================================
    // UI — CRÉATION DU MODAL
    // ============================================

    createUI() {
        const html = `
        <div class="modal debate-module-modal" id="debateModuleModal">
            <div class="debate-module-container">
                <button class="debate-close-btn" id="closeDebateModule" aria-label="Fermer">✕</button>

                <!-- Header -->
                <div class="debate-header">
                    <div class="debate-state-info">
                        <span class="debate-state-icon">⏳</span>
                        <span class="debate-state-text" id="debateStateText">Chargement…</span>
                    </div>
                    <div class="debate-timer" id="debateTimer">-:--</div>
                    <div class="debate-participants-info">
                        <span>👥</span>
                        <span id="debateParticipantCount">0</span>
                    </div>
                </div>

                <!-- Main -->
                <div class="debate-main-area" id="debateMainArea">
                    <div class="debate-waiting-screen">
                        <div class="debate-waiting-icon">⏳</div>
                        <h2>Chargement…</h2>
                    </div>
                </div>

                <!-- Interaction -->
                <div class="debate-interaction-area" id="debateInteractionArea"></div>

                <!-- Footer rôle -->
                <div class="debate-footer">
                    <div class="debate-role-badge" id="debateRoleBadge">
                        <span class="role-icon">👤</span>
                        <span id="debateRoleText">En attente…</span>
                    </div>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    setupEventListeners() {
        document.getElementById('closeDebateModule')?.addEventListener('click', () => {
            this.closeDebateModule();
        });
    }

    // ============================================
    // REALTIME SYNC (Supabase postgres_changes)
    // ============================================

    startRealtimeSync() {
        // Le timer tourne TOUJOURS (modal ouverte ou non) pour gérer les transitions
        this.timerInterval = setInterval(() => {
            this.updateTimerOnly();
            // Vérifier la progression à chaque seconde pour tout le monde
            this.checkStateProgression();
        }, 1000);

        this.realtimeChannel = this.client.client
            .channel('debate_sessions_changes')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'debate_sessions',
                filter: 'is_active=eq.true'
            }, (payload) => {
                console.log('[DEBATE] 📡 Realtime update');
                this.handleRealtimeUpdate(payload);
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') console.log('[DEBATE] ✅ Realtime connecté');
            });

        this.loadInitialSession();
    }

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
                this.updateFromSession(sessions[0]);
            }

            this.updateBadge();
            if (this.isActive) this.updateUI();
        } catch (err) {
            console.error('[DEBATE] Erreur chargement initial:', err);
        }
    }

    async handleRealtimeUpdate(payload) {
        const { eventType, new: rec } = payload;

        if ((eventType === 'INSERT' || eventType === 'UPDATE') && rec?.is_active) {
            this.updateFromSession(rec);
        } else if (eventType === 'DELETE') {
            this.currentSessionId = null;
            this.currentState = 'WAITING';
            this.sessionData.participants = [];
            this.myRole = null;
        }

        this.updateBadge();
        if (this.isActive) this.updateUI();
        // Toujours vérifier la progression, même modal fermée
        await this.checkStateProgression();
    }

    updateFromSession(session) {
        this.currentSessionId = session.id;
        this.currentState = session.state;
        this.sessionData = {
            participants:      session.participants      || [],
            decisionnaire:     session.decisionnaire    || null,
            lawyer1:           session.lawyer1           || null,
            lawyer2:           session.lawyer2           || null,
            spectators:        [],
            question:          session.question          || '',
            lawyerMessages:    session.lawyer_messages   || [],
            spectatorMessages: session.spectator_messages || [],
            votes:             session.votes             || {},
            stateStartTime:    session.state_start_time  || Date.now()
        };
        this.updateMyRole();
    }

    getSessionUpdateObject() {
        return {
            participants:       this.sessionData.participants    || [],
            decisionnaire:      this.sessionData.decisionnaire,
            lawyer1:            this.sessionData.lawyer1,
            lawyer2:            this.sessionData.lawyer2,
            question:           this.sessionData.question        || '',
            lawyer_messages:    this.sessionData.lawyerMessages  || [],
            spectator_messages: this.sessionData.spectatorMessages || [],
            votes:              this.sessionData.votes            || {},
            state_start_time:   this.sessionData.stateStartTime   || Date.now()
        };
    }

    stopRealtimeSync() {
        if (this.realtimeChannel) {
            this.client.client.removeChannel(this.realtimeChannel);
            this.realtimeChannel = null;
        }
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    // ============================================
    // TIMER LOCAL (1s, sans requête)
    // ============================================

    updateTimerOnly() {
        const timer = document.getElementById('debateTimer');
        if (!timer) return;

        const durationMap = {
            STABILIZING: this.config.stabilizationTime,
            COUNTDOWN:   this.config.countdownTime,
            QUESTION:    this.config.questionTime,
            DEBATE:      this.config.debateTime,
            VOTING:      this.config.votingTime,
            RESULT:      this.config.resultTime
        };

        const duration  = durationMap[this.currentState] || 0;
        const elapsed   = Date.now() - this.sessionData.stateStartTime;
        const remaining = Math.max(0, duration - elapsed);
        const secs      = Math.floor(remaining / 1000);
        const mins      = Math.floor(secs / 60);
        timer.textContent = `${mins}:${(secs % 60).toString().padStart(2, '0')}`;

        timer.classList.remove('timer-normal', 'timer-warning', 'timer-critical');
        if (secs <= 10)      timer.classList.add('timer-critical');
        else if (secs <= 30) timer.classList.add('timer-warning');
        else                 timer.classList.add('timer-normal');

        const badge = document.getElementById('debateBadge');
        if (badge) {
            if (this.currentState === 'DEBATE' && secs <= 30) badge.classList.add('pulse-fast');
            else badge.classList.remove('pulse-fast');
        }
    }

    updateMyRole() {
        const { decisionnaire, lawyer1, lawyer2 } = this.sessionData;
        if (decisionnaire === this.userId) this.myRole = 'decisionnaire';
        else if (lawyer1 === this.userId)  this.myRole = 'lawyer1';
        else if (lawyer2 === this.userId)  this.myRole = 'lawyer2';
        else                               this.myRole = 'spectator';
    }

    // ============================================
    // PROGRESSION D'ÉTAT
    // ============================================

    async checkStateProgression() {
        if (!this.currentSessionId) return;

        // Anti-doublon : éviter que 2 clients déclenchent la même transition simultanément
        // Chaque client a un délai aléatoire + on vérifie que l'état n'a pas déjà changé
        const elapsed     = Date.now() - this.sessionData.stateStartTime;
        const count       = this.sessionData.participants?.length || 0;

        // Délai aléatoire basé sur la position dans la liste pour éviter les collisions
        const myIndex    = this.sessionData.participants?.indexOf(this.userId) ?? 0;
        const safeIndex  = myIndex < 0 ? 0 : myIndex;
        const randomDelay = safeIndex * 200 + Math.random() * 150;

        // Protection contre les transitions multiples
        const transitionKey = `${this.currentSessionId}_${this.currentState}`;
        if (this._pendingTransition === transitionKey) return;

        switch (this.currentState) {
            case 'WAITING':
                // N'importe quel participant peut déclencher si assez de joueurs
                if (count >= this.config.minPlayers) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        // Re-vérifier que l'état n'a pas déjà changé (quelqu'un d'autre l'a fait)
                        if (this.currentState === 'WAITING' && this.currentSessionId) {
                            await this.transitionToState('STABILIZING');
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;

            case 'STABILIZING':
                if (elapsed >= this.config.stabilizationTime) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        if (this.currentState === 'STABILIZING' && this.currentSessionId) {
                            await this.assignRoles();
                            await this.transitionToState('COUNTDOWN');
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;

            case 'COUNTDOWN':
                if (elapsed >= this.config.countdownTime) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        if (this.currentState === 'COUNTDOWN' && this.currentSessionId) {
                            await this.transitionToState('QUESTION');
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;

            case 'QUESTION':
                if (elapsed >= this.config.questionTime) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        if (this.currentState === 'QUESTION' && this.currentSessionId) {
                            if (!this.sessionData.question) await this.setDefaultQuestion();
                            await this.transitionToState('DEBATE');
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;

            case 'DEBATE':
                if (elapsed >= this.config.debateTime) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        if (this.currentState === 'DEBATE' && this.currentSessionId) {
                            await this.transitionToState('VOTING');
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;

            case 'VOTING':
                if (elapsed >= this.config.votingTime) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        if (this.currentState === 'VOTING' && this.currentSessionId) {
                            await this.transitionToState('RESULT');
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;

            case 'RESULT':
                if (elapsed >= this.config.resultTime) {
                    this._pendingTransition = transitionKey;
                    setTimeout(async () => {
                        if (this.currentState === 'RESULT' && this.currentSessionId) {
                            await this.endSession();
                        }
                        this._pendingTransition = null;
                    }, randomDelay);
                }
                break;
        }
    }

    hasParticipantsChanged() {
        if (!this.lastParticipantsList) {
            this.lastParticipantsList = [...this.sessionData.participants];
            return false;
        }
        const curr = [...this.sessionData.participants].sort();
        const last = [...this.lastParticipantsList].sort();
        if (curr.length !== last.length) return true;
        for (let i = 0; i < curr.length; i++) if (curr[i] !== last[i]) return true;
        return false;
    }

    async saveSession() {
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
        } catch (err) {
            console.error('[DEBATE] Erreur saveSession:', err);
        }
    }

    async transitionToState(newState) {
        console.log(`[DEBATE] ${this.currentState} → ${newState}`);
        this.sessionData.stateStartTime = Date.now();
        try {
            const { error } = await this.client.client
                .from('debate_sessions')
                .update({ state: newState, ...this.getSessionUpdateObject() })
                .eq('id', this.currentSessionId);
            if (error) throw error;
            console.log(`[DEBATE] ✅ ${newState}`);
        } catch (err) {
            console.error('[DEBATE] Erreur transition:', err);
        }
    }

    async assignRoles() {
        const shuffled = [...this.sessionData.participants].sort(() => Math.random() - 0.5);
        this.sessionData.decisionnaire = shuffled[0];
        this.sessionData.lawyer1       = shuffled[1];
        this.sessionData.lawyer2       = shuffled[2];
        this.sessionData.spectators    = shuffled.slice(3);
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
        } catch (err) {
            console.error('[DEBATE] Erreur assignRoles:', err);
        }
    }

    async setDefaultQuestion() {
        const defaults = [
            "Les chats sont-ils meilleurs que les chiens ?",
            "L'ananas a-t-il sa place sur une pizza ?",
            "Est-il préférable d'être riche ou célèbre ?",
            "Pain au chocolat ou chocolatine ?",
            "Les séries sont-elles meilleures que les films ?"
        ];
        this.sessionData.question = defaults[Math.floor(Math.random() * defaults.length)];
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
        } catch (err) {
            console.error('[DEBATE] Erreur question par défaut:', err);
        }
    }

    async endSession() {
        console.log('[DEBATE] 🏁 Fin session');
        try {
            await this.client.client
                .from('debate_sessions')
                .update({ is_active: false })
                .eq('id', this.currentSessionId);

            this.currentSessionId = null;
            this.currentState     = 'WAITING';
            this.myRole           = null;
            this.previousLeader   = null;
            this.sessionData = {
                participants: [], decisionnaire: null, lawyer1: null, lawyer2: null,
                spectators: [], question: '', lawyerMessages: [],
                spectatorMessages: [], votes: {}, stateStartTime: Date.now()
            };
            this.updateBadge();
            if (this.isActive) this.updateUI();
        } catch (err) {
            console.error('[DEBATE] Erreur endSession:', err);
        }
    }

    // ============================================
    // MESSAGES & VOTES
    // ============================================

    async sendLawyerMessage(message) {
        if (this.myRole !== 'lawyer1' && this.myRole !== 'lawyer2') return;
        const now = Date.now();
        if (now - this.lastMessageTime < this.messageCooldown) {
            const rem = Math.ceil((this.messageCooldown - (now - this.lastMessageTime)) / 1000);
            this.showDebateToast(`Patiente ${rem}s…`, 'warning');
            return;
        }
        if (!message?.trim() || message.length > 200) return;
        this.lastMessageTime = now;

        const msg = {
            id:        `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            userId:    this.userId,
            role:      this.myRole,
            content:   this.escapeHTML(message.trim()),
            timestamp: now
        };
        this.sessionData.lawyerMessages.push(msg);
        this.updateDebateMessagesOnly();

        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
            this.audio?.playSound('addOpinion');
        } catch (err) {
            console.error('[DEBATE] Erreur envoi message avocat:', err);
            this.sessionData.lawyerMessages.pop();
            this.updateDebateMessagesOnly();
            this.showDebateToast('Erreur envoi', 'error');
        }
    }

    async sendSpectatorMessage(message) {
        if (this.myRole !== 'spectator') return;
        const now = Date.now();
        if (now - this.lastMessageTime < this.messageCooldown) {
            const rem = Math.ceil((this.messageCooldown - (now - this.lastMessageTime)) / 1000);
            this.showDebateToast(`Patiente ${rem}s…`, 'warning');
            return;
        }
        if (!message?.trim() || message.length > 150) return;
        this.lastMessageTime = now;

        const msg = {
            id:        `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            userId:    this.userId,
            content:   this.escapeHTML(message.trim()),
            timestamp: now
        };
        this.sessionData.spectatorMessages.push(msg);
        this.updateDebateMessagesOnly();

        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
            this.audio?.playSound('setPostIt');
        } catch (err) {
            console.error('[DEBATE] Erreur spectator msg:', err);
            this.sessionData.spectatorMessages.pop();
            this.updateDebateMessagesOnly();
            this.showDebateToast('Erreur envoi', 'error');
        }
    }

    async submitQuestion(question) {
        if (this.myRole !== 'decisionnaire') return;
        if (!question?.trim() || question.length > 120) {
            this.showDebateToast('Question invalide (max 120 chars)', 'error');
            return;
        }
        this.sessionData.question = this.escapeHTML(question.trim());
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
            this.showDebateToast('Question enregistrée !', 'success');
            this.audio?.playSound('setPostIt');
        } catch (err) {
            console.error('[DEBATE] Erreur submitQuestion:', err);
        }
    }

    async submitVote(lawyerId) {
        if (this.myRole !== 'spectator') return;
        if (this.sessionData.votes[this.userId]) {
            this.showDebateToast('Déjà voté !', 'warning');
            return;
        }
        this.sessionData.votes[this.userId] = lawyerId;
        try {
            await this.client.client
                .from('debate_sessions')
                .update(this.getSessionUpdateObject())
                .eq('id', this.currentSessionId);
            this.showDebateToast('Vote enregistré ! 🗳️', 'success');
            this.audio?.playSound('afterVoting');
            this.checkAndAnnounceLeaderChange();
        } catch (err) {
            console.error('[DEBATE] Erreur vote:', err);
        }
    }

    // ============================================
    // CLEANUP SESSIONS ZOMBIES
    // ============================================

    async cleanupOldSessions() {
        try {
            const { data: sessions } = await this.client.client
                .from('debate_sessions')
                .select('*')
                .eq('is_active', true);
            if (!sessions?.length) return;

            const now = Date.now();
            const maxAge = Object.values(this.config).reduce((a, b) => a + b, 0) + 30000;
            const toClean = [];

            for (const s of sessions) {
                const age = now - (s.state_start_time || 0);
                if (
                    age > maxAge ||
                    (s.state === 'WAITING' && age > 180000) ||
                    (s.state === 'RESULT'  && age > 30000)  ||
                    !s.participants?.length
                ) {
                    toClean.push(s.id);
                }
            }

            if (toClean.length > 0) {
                await this.client.client
                    .from('debate_sessions')
                    .update({ is_active: false })
                    .in('id', toClean);
                console.log(`[DEBATE] 🧹 ${toClean.length} session(s) nettoyée(s)`);
            }
        } catch (err) {
            console.error('[DEBATE] Erreur cleanup:', err);
        }
    }

    // ============================================
    // OUVERTURE / FERMETURE
    // ============================================

    async openDebateModule() {
        await this.cleanupOldSessions();

        // Chercher session WAITING existante
        const { data: existing } = await this.client.client
            .from('debate_sessions')
            .select('*')
            .eq('is_active', true)
            .eq('state', 'WAITING')
            .limit(1);

        if (existing?.length) {
            const s = existing[0];
            this.currentSessionId = s.id;
            this.currentState = s.state;
            this.sessionData = {
                participants:      s.participants       || [],
                decisionnaire:     s.decisionnaire      || null,
                lawyer1:           s.lawyer1             || null,
                lawyer2:           s.lawyer2             || null,
                spectators:        [],
                question:          s.question            || '',
                lawyerMessages:    s.lawyer_messages     || [],
                spectatorMessages: s.spectator_messages  || [],
                votes:             s.votes               || {},
                stateStartTime:    s.state_start_time    || Date.now()
            };

            if (!this.sessionData.participants.includes(this.userId)) {
                this.sessionData.participants.push(this.userId);
                await this.client.client
                    .from('debate_sessions')
                    .update(this.getSessionUpdateObject())
                    .eq('id', this.currentSessionId);
            }
            this.updateMyRole();
        } else {
            // Créer nouvelle session
            try {
                const { data, error } = await this.client.client
                    .from('debate_sessions')
                    .insert({
                        state:             'WAITING',
                        is_active:         true,
                        participants:      [this.userId],
                        decisionnaire:     null,
                        lawyer1:           null,
                        lawyer2:           null,
                        question:          '',
                        lawyer_messages:   [],
                        spectator_messages:[],
                        votes:             {},
                        state_start_time:  Date.now()
                    })
                    .select()
                    .single();

                if (error) throw error;
                this.currentSessionId = data.id;
                this.sessionData.participants = [this.userId];
            } catch (err) {
                console.error('[DEBATE] Erreur création session:', err);
            }
        }

        this.isActive = true;
        document.getElementById('debateModuleModal')?.classList.add('active');
        this.updateUI();
        this.audio?.playSound('setPostIt');
    }

    closeDebateModule() {
        this.isActive = false;
        document.getElementById('debateModuleModal')?.classList.remove('active');

        // Si WAITING et seul → nettoyer
        if (
            this.currentState === 'WAITING' &&
            this.currentSessionId &&
            this.sessionData.participants.length === 1 &&
            this.sessionData.participants[0] === this.userId
        ) {
            this.client.client
                .from('debate_sessions')
                .update({ is_active: false })
                .eq('id', this.currentSessionId)
                .then(() => { this.currentSessionId = null; });
        }
    }

    // ============================================
    // BADGE UPDATE
    // ============================================

    updateBadge() {
        const badge = document.getElementById('debateBadge');
        if (!badge) return;

        const dot   = badge.querySelector('.debate-status-dot');
        const text  = badge.querySelector('.debate-badge-text');
        const count = badge.querySelector('.debate-participant-count');
        const n     = this.sessionData.participants?.length || 0;

        badge.classList.remove('waiting', 'stabilizing', 'active', 'voting', 'hype-high');

        switch (this.currentState) {
            case 'WAITING':
                badge.classList.add('waiting');
                text.textContent = n === 0 ? 'Lobby' : n < 4 ? 'En attente…' : 'Prêt !';
                count.textContent = n > 0 ? `${n}` : '';
                break;
            case 'STABILIZING':
            case 'COUNTDOWN':
                badge.classList.add('stabilizing');
                text.textContent = 'Ça démarre !';
                count.textContent = `${n}`;
                break;
            case 'QUESTION':
                badge.classList.add('active');
                text.textContent = '🔴 LIVE';
                count.textContent = `${n}`;
                break;
            case 'DEBATE':
                badge.classList.add('active');
                if (n >= 10) { badge.classList.add('hype-high'); text.textContent = '🔴 Ça chauffe !'; }
                else if (n >= 5) { badge.classList.add('hype-high'); text.textContent = '🔴 Ça débat !'; }
                else text.textContent = '🔴 LIVE';
                count.textContent = `${n}`;
                break;
            case 'VOTING':
                badge.classList.add('voting');
                const votes = Object.keys(this.sessionData.votes || {}).length;
                text.textContent = '🗳️ Vote';
                count.textContent = `${votes}v`;
                break;
            case 'RESULT':
                badge.classList.add('active');
                text.textContent = 'Résultat 🏆';
                count.textContent = `${n}`;
                break;
        }
    }

    // ============================================
    // UI UPDATE CENTRAL
    // ============================================

    updateUI() {
        const mainArea       = document.getElementById('debateMainArea');
        const interactionArea= document.getElementById('debateInteractionArea');
        const countEl        = document.getElementById('debateParticipantCount');
        const stateTextEl    = document.getElementById('debateStateText');
        const roleText       = document.getElementById('debateRoleText');
        const roleBadge      = document.getElementById('debateRoleBadge');

        if (!mainArea) return;

        // Compteur
        if (countEl) countEl.textContent = this.sessionData.participants?.length || 0;

        // Texte d'état
        const stateNames = {
            WAITING:     'En attente…',
            STABILIZING: 'Vérification…',
            COUNTDOWN:   'Démarrage !',
            QUESTION:    '❓ Choix question',
            DEBATE:      '💬 Débat en cours',
            VOTING:      '🗳️ Phase de vote',
            RESULT:      '🏆 Résultat'
        };
        if (stateTextEl) stateTextEl.textContent = stateNames[this.currentState] || this.currentState;

        // Badge rôle
        if (roleText && roleBadge) {
            const icons = { decisionnaire:'⚖️', lawyer1:'👔', lawyer2:'👔', spectator:'👁️' };
            const names = { decisionnaire:'Décisionnaire', lawyer1:'Avocat 1', lawyer2:'Avocat 2', spectator:'Spectateur' };
            roleBadge.querySelector('.role-icon').textContent = icons[this.myRole] || '👤';
            roleText.textContent = names[this.myRole] || 'En attente…';
            roleBadge.classList.remove('role-decisionnaire', 'role-lawyer', 'role-spectator');
            if (this.myRole === 'decisionnaire')               roleBadge.classList.add('role-decisionnaire');
            else if (this.myRole === 'lawyer1' || this.myRole === 'lawyer2') roleBadge.classList.add('role-lawyer');
            else if (this.myRole === 'spectator')              roleBadge.classList.add('role-spectator');
        }

        // Smart render (évite les re-renders inutiles)
        const stateKey = `${this.currentState}_${this.myRole}_${this.sessionData.question}_${this.sessionData.votes[this.userId] || ''}`;
        const prev     = this.previousRenderState;

        const shouldRerender = prev.stateKey !== stateKey;
        const shouldChatUpdate = this.currentState === 'DEBATE' && (
            prev.lawyerCount !== this.sessionData.lawyerMessages.length ||
            prev.spectatorCount !== this.sessionData.spectatorMessages.length
        );
        const shouldVoteUpdate = this.currentState === 'VOTING' &&
            prev.votesCount !== Object.keys(this.sessionData.votes).length;

        this.previousRenderState = {
            stateKey,
            lawyerCount:    this.sessionData.lawyerMessages.length,
            spectatorCount: this.sessionData.spectatorMessages.length,
            votesCount:     Object.keys(this.sessionData.votes).length
        };

        if (shouldRerender) {
            const renders = {
                WAITING:     () => this.renderWaitingScreen(mainArea, interactionArea),
                STABILIZING: () => this.renderStabilizingScreen(mainArea, interactionArea),
                COUNTDOWN:   () => this.renderCountdownScreen(mainArea, interactionArea),
                QUESTION:    () => this.renderQuestionScreen(mainArea, interactionArea),
                DEBATE:      () => this.renderDebateScreen(mainArea, interactionArea),
                VOTING:      () => this.renderVotingScreen(mainArea, interactionArea),
                RESULT:      () => this.renderResultScreen(mainArea, interactionArea)
            };
            renders[this.currentState]?.();
        } else if (shouldChatUpdate) {
            this.updateDebateMessagesOnly();
        } else if (shouldVoteUpdate) {
            this.updateVoteCountsOnly();
        }
    }

    // ============================================
    // MISES À JOUR LÉGÈRES
    // ============================================

    updateDebateMessagesOnly() {
        const lawyersChat   = document.getElementById('lawyersChat');
        const spectatorsChat= document.getElementById('spectatorsChat');

        if (lawyersChat) {
            lawyersChat.innerHTML = this.sessionData.lawyerMessages.length
                ? this.sessionData.lawyerMessages.map(msg => {
                    const isL1 = msg.role === 'lawyer1';
                    return `<div class="lawyer-message ${isL1 ? 'lawyer-1' : 'lawyer-2'}">
                        <div class="lawyer-name">${isL1 ? 'Avocat 1' : 'Avocat 2'}</div>
                        <div class="lawyer-text">${msg.content}</div>
                    </div>`;
                }).join('')
                : '<p class="no-messages">Le débat n\'a pas encore commencé…</p>';
            lawyersChat.scrollTop = lawyersChat.scrollHeight;
        }

        if (spectatorsChat) {
            spectatorsChat.innerHTML = this.renderSpectatorMessages();
            spectatorsChat.scrollTop = spectatorsChat.scrollHeight;
        }
    }

    updateVoteCountsOnly() {
        const votes1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const votes2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const total  = votes1 + votes2;
        const cards  = document.querySelectorAll('.debate-vote-card');
        if (cards.length === 2) {
            cards[0].querySelector('.vote-count').textContent = votes1;
            cards[1].querySelector('.vote-count').textContent = votes2;
            if (total > 0) {
                const p1 = cards[0].querySelector('.vote-percentage');
                const p2 = cards[1].querySelector('.vote-percentage');
                if (p1) p1.textContent = `${Math.round(votes1/total*100)}%`;
                if (p2) p2.textContent = `${Math.round(votes2/total*100)}%`;
            }
        }
        const countEl = document.querySelector('.debate-vote-count');
        if (countEl) countEl.textContent = `${total} vote${total > 1 ? 's' : ''}`;

        // Mettre à jour la jauge de tension
        const gaugeEl = document.querySelector('.debate-tension-gauge');
        if (gaugeEl && total > 0) {
            const ratio   = votes1 / total;
            const tension = Math.round((1 - Math.abs(ratio - 0.5) * 2) * 100);
            const fill    = gaugeEl.querySelector('.tension-fill');
            const pct     = gaugeEl.querySelector('.tension-percentage');
            if (fill) fill.style.width = `${tension}%`;
            if (pct)  pct.textContent  = `${tension}%`;
            gaugeEl.className = `debate-tension-gauge tension-${
                tension > 70 ? 'extreme' : tension > 50 ? 'high' : tension > 30 ? 'medium' : 'low'
            }`;
        }
    }

    // ============================================
    // CHANGEMENT DE LEADER (hype)
    // ============================================

    checkAndAnnounceLeaderChange() {
        const v1 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const v2 = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const leader = v1 > v2 ? 'lawyer1' : v2 > v1 ? 'lawyer2' : null;

        if (!this.previousLeader) { this.previousLeader = leader; return; }

        if (leader && leader !== this.previousLeader) {
            const name = leader === 'lawyer1' ? 'Avocat 1' : 'Avocat 2';
            this.showDebateToast(`🔄 ${name} reprend l'avantage !`, 'info');
            this.audio?.playSound('setPostIt');
            const main = document.getElementById('debateMainArea');
            if (main) {
                main.classList.add('leader-change-flash');
                setTimeout(() => main.classList.remove('leader-change-flash'), 600);
            }
            this.previousLeader = leader;
        }
    }

    // ============================================
    // RENDUS D'ÉCRANS
    // ============================================

    renderWaitingScreen(mainArea, interactionArea) {
        const count = this.sessionData.participants?.length || 0;
        const pct   = Math.min(Math.round(count / this.config.minPlayers * 100), 100);

        mainArea.innerHTML = `
        <div class="debate-waiting-screen">
            <div class="debate-waiting-icon">⚖️</div>
            <h2>Salle d'attente</h2>
            <div class="debate-player-count">
                <span class="big-number">${count}</span>
                <span class="player-label">/ ${this.config.minPlayers} joueurs min</span>
            </div>
            <div class="debate-progress-bar">
                <div class="debate-progress-fill" style="width:${pct}%"></div>
            </div>
            <p class="debate-waiting-hint">
                ${count >= this.config.minPlayers ? '✅ Démarrage dans quelques secondes…' : '⏱️ En attente de joueurs…'}
            </p>
            <div class="debate-rules-card">
                <div class="rules-title">🎭 Comment ça marche</div>
                <div class="rules-list">
                    <div class="rule-item">
                        <span class="rule-icon">⚖️</span>
                        <span>1 Décisionnaire choisit la question du débat</span>
                    </div>
                    <div class="rule-item">
                        <span class="rule-icon">👔</span>
                        <span>2 Avocats défendent chacun une position pendant 60s</span>
                    </div>
                    <div class="rule-item">
                        <span class="rule-icon">🗳️</span>
                        <span>Les spectateurs votent pour le meilleur argument</span>
                    </div>
                </div>
            </div>
        </div>`;
        interactionArea.innerHTML = '';
    }

    renderStabilizingScreen(mainArea, interactionArea) {
        const count = this.sessionData.participants?.length || 0;
        mainArea.innerHTML = `
        <div class="debate-stabilizing-screen">
            <div class="debate-spinner">⚙️</div>
            <h2>Vérification des joueurs</h2>
            <p class="stabilize-sub">${count} joueur${count > 1 ? 's' : ''} prêt${count > 1 ? 's' : ''} — Attribution des rôles…</p>
        </div>`;
        interactionArea.innerHTML = '';
    }

    renderCountdownScreen(mainArea, interactionArea) {
        const rem = Math.max(0, this.config.countdownTime - (Date.now() - this.sessionData.stateStartTime));
        const num = Math.ceil(rem / 1000) || '🎬';
        mainArea.innerHTML = `
        <div class="debate-countdown-screen">
            <div class="debate-countdown-number">${num}</div>
            <h2>Préparez-vous !</h2>
            <p class="stabilize-sub">Les rôles ont été attribués…</p>
        </div>`;
        interactionArea.innerHTML = '';
    }

    renderQuestionScreen(mainArea, interactionArea) {
        const hasQ = !!this.sessionData.question;

        mainArea.innerHTML = `
        <div class="debate-question-screen">
            <div class="debate-phase-banner">
                <span class="phase-icon">❓</span>
                <span class="phase-text">Phase de question</span>
            </div>
            ${hasQ ? `
            <div class="debate-question-display">
                <h3>Question choisie</h3>
                <p class="debate-question-text">${this.sessionData.question}</p>
                <p class="debate-hint">⏱️ Le débat commence bientôt…</p>
            </div>` : `
            <div class="debate-question-waiting">
                <div class="debate-hourglass">⏳</div>
                <h3>En attente de la question…</h3>
                <p>Le décisionnaire choisit le sujet du débat</p>
            </div>`}
        </div>`;

        if (this.myRole === 'decisionnaire' && !hasQ) {
            interactionArea.innerHTML = `
            <div class="debate-question-input-zone">
                <h4>⚖️ C'est à toi de choisir !</h4>
                <p>Pose une question qui va créer le débat</p>
                <div class="debate-input-container">
                    <input type="text" id="questionInput" class="debate-input"
                        placeholder="Ex : Les séries valent-elles mieux que les films ?"
                        maxlength="120" autocomplete="off">
                    <button class="debate-submit-btn" id="submitQuestionBtn">Valider</button>
                </div>
            </div>`;

            const btn = document.getElementById('submitQuestionBtn');
            const inp = document.getElementById('questionInput');
            const send = () => { if (inp?.value.trim()) this.submitQuestion(inp.value); };
            btn?.addEventListener('click', send);
            inp?.addEventListener('keypress', e => { if (e.key === 'Enter') send(); });
            inp?.focus();

        } else if (hasQ) {
            interactionArea.innerHTML = `
            <div class="debate-info-box success">✅ Question validée — Le débat va commencer !</div>`;
        } else {
            const roleHint = {
                lawyer1:   '👔 Tu es Avocat 1 — prépare tes arguments !',
                lawyer2:   '👔 Tu es Avocat 2 — prépare tes arguments !',
                spectator: '👁️ Tu es Spectateur — observe et prépare ton vote !'
            };
            interactionArea.innerHTML = `
            <div class="debate-info-box">${roleHint[this.myRole] || '⏳ En attente du décisionnaire…'}</div>`;
        }
    }

    renderDebateScreen(mainArea, interactionArea) {
        const msgs = this.sessionData.lawyerMessages.map(msg => {
            const isL1 = msg.role === 'lawyer1';
            return `<div class="lawyer-message ${isL1 ? 'lawyer-1' : 'lawyer-2'}">
                <div class="lawyer-name">${isL1 ? 'Avocat 1' : 'Avocat 2'}</div>
                <div class="lawyer-text">${msg.content}</div>
            </div>`;
        }).join('') || '<p class="no-messages">Le débat n\'a pas encore commencé…</p>';

        mainArea.innerHTML = `
        <div class="debate-active-screen">
            <div class="debate-topic-banner">
                <span class="topic-icon">💬</span>
                <span class="debate-topic-text">${this.sessionData.question || 'Question en attente…'}</span>
            </div>

            <div class="debate-lawyers-zone">
                <div class="lawyers-title">🎙️ Zone des Avocats</div>
                <div class="lawyers-chat" id="lawyersChat">${msgs}</div>
            </div>

            <div class="debate-spectators-zone">
                <div class="spectators-title">👁️ Réactions</div>
                <div class="spectators-chat" id="spectatorsChat">${this.renderSpectatorMessages()}</div>
            </div>
        </div>`;

        setTimeout(() => {
            document.getElementById('lawyersChat')?.scrollTo({ top: 99999, behavior: 'smooth' });
            document.getElementById('spectatorsChat')?.scrollTo({ top: 99999, behavior: 'smooth' });
        }, 60);

        // Zone d'interaction
        if (this.myRole === 'lawyer1' || this.myRole === 'lawyer2') {
            const roleClass = this.myRole === 'lawyer1' ? 'lawyer-1' : 'lawyer-2';
            const roleLabel = this.myRole === 'lawyer1' ? 'Avocat 1' : 'Avocat 2';
            interactionArea.innerHTML = `
            <div class="debate-lawyer-input-zone">
                <span class="role-indicator ${roleClass}">👔 ${roleLabel} — Défends ta position</span>
                <div class="debate-input-container">
                    <input type="text" id="lawyerMessageInput" class="debate-input"
                        placeholder="Ton argument…" maxlength="200" autocomplete="off">
                    <button class="debate-submit-btn" id="sendLawyerMessageBtn">Envoyer</button>
                </div>
            </div>`;

            const btn = document.getElementById('sendLawyerMessageBtn');
            const inp = document.getElementById('lawyerMessageInput');
            const send = () => {
                if (inp?.value.trim()) { this.sendLawyerMessage(inp.value); inp.value = ''; }
            };
            btn?.addEventListener('click', send);
            inp?.addEventListener('keypress', e => { if (e.key === 'Enter') send(); });

        } else if (this.myRole === 'spectator') {
            interactionArea.innerHTML = `
            <div class="debate-spectator-input-zone">
                <span class="role-indicator spectator">👁️ Spectateur — Réagis en direct</span>
                <div class="debate-input-container">
                    <input type="text" id="spectatorMessageInput" class="debate-input"
                        placeholder="Ton avis…" maxlength="150" autocomplete="off">
                    <button class="debate-submit-btn" id="sendSpectatorMessageBtn">Envoyer</button>
                </div>
            </div>`;

            const btn = document.getElementById('sendSpectatorMessageBtn');
            const inp = document.getElementById('spectatorMessageInput');
            const send = () => {
                if (inp?.value.trim()) { this.sendSpectatorMessage(inp.value); inp.value = ''; }
            };
            btn?.addEventListener('click', send);
            inp?.addEventListener('keypress', e => { if (e.key === 'Enter') send(); });

        } else {
            interactionArea.innerHTML = `
            <div class="debate-info-box">⚖️ Tu es le décisionnaire — observe le débat !</div>`;
        }
    }

    renderSpectatorMessages() {
        if (!this.sessionData.spectatorMessages.length) {
            return '<p class="no-messages">Aucune réaction…</p>';
        }
        return this.sessionData.spectatorMessages.map(msg => {
            const isMe = msg.userId === this.userId;
            return `<span class="spectator-message${isMe ? ' my-message' : ''}">${msg.content}</span>`;
        }).join('');
    }

    renderVotingScreen(mainArea, interactionArea) {
        const v1    = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const v2    = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const total = v1 + v2;
        const voted = !!this.sessionData.votes[this.userId];

        mainArea.innerHTML = `
        <div class="debate-voting-screen">
            ${this.renderTensionGauge(v1, v2)}
            <h2>À toi de voter !</h2>
            <p class="debate-question-reminder">${this.sessionData.question}</p>
            <div class="debate-vote-options">
                <div class="debate-vote-card${this.sessionData.votes[this.userId] === 'lawyer1' ? ' voted' : ''}">
                    <div class="vote-lawyer-name">👔 Avocat 1</div>
                    <div class="vote-count">${v1}</div>
                    ${total > 0 ? `<div class="vote-percentage">${Math.round(v1/total*100)}%</div>` : '<div class="vote-percentage">-</div>'}
                </div>
                <div class="debate-vote-card${this.sessionData.votes[this.userId] === 'lawyer2' ? ' voted' : ''}">
                    <div class="vote-lawyer-name">👔 Avocat 2</div>
                    <div class="vote-count">${v2}</div>
                    ${total > 0 ? `<div class="vote-percentage">${Math.round(v2/total*100)}%</div>` : '<div class="vote-percentage">-</div>'}
                </div>
            </div>
            <p class="debate-vote-count">${total} vote${total > 1 ? 's' : ''}</p>
        </div>`;

        if (this.myRole === 'spectator') {
            if (voted) {
                interactionArea.innerHTML = `<div class="debate-info-box success">✅ Vote enregistré !</div>`;
            } else {
                interactionArea.innerHTML = `
                <div class="debate-vote-buttons">
                    <button class="debate-vote-btn lawyer1" id="voteLawyer1Btn">
                        <span class="vote-icon">👔</span>Avocat 1
                    </button>
                    <button class="debate-vote-btn lawyer2" id="voteLawyer2Btn">
                        <span class="vote-icon">👔</span>Avocat 2
                    </button>
                </div>`;
                document.getElementById('voteLawyer1Btn')?.addEventListener('click', () => this.submitVote('lawyer1'));
                document.getElementById('voteLawyer2Btn')?.addEventListener('click', () => this.submitVote('lawyer2'));
            }
        } else {
            interactionArea.innerHTML = `<div class="debate-info-box">⏳ En attente des votes des spectateurs…</div>`;
        }
    }

    renderTensionGauge(v1, v2) {
        const total = v1 + v2;
        if (total === 0) return '';
        const ratio   = v1 / total;
        const tension = Math.round((1 - Math.abs(ratio - 0.5) * 2) * 100);
        const cls     = tension > 70 ? 'extreme' : tension > 50 ? 'high' : tension > 30 ? 'medium' : 'low';
        const label   = tension > 70 ? 'Extrême ! 🔥' : tension > 50 ? 'Intense !' : tension > 30 ? 'Modérée' : 'Tranquille';

        return `
        <div class="debate-tension-gauge tension-${cls}">
            <div class="tension-label">
                <span class="tension-icon">⚡</span>
                <span>Intensité : ${label}</span>
            </div>
            <div class="tension-bar-container">
                <div class="tension-track">
                    <div class="tension-fill" style="width:${tension}%"></div>
                </div>
                <div class="tension-percentage">${tension}%</div>
            </div>
        </div>`;
    }

    renderResultScreen(mainArea, interactionArea) {
        const v1    = Object.values(this.sessionData.votes).filter(v => v === 'lawyer1').length;
        const v2    = Object.values(this.sessionData.votes).filter(v => v === 'lawyer2').length;
        const total = v1 + v2;
        const winner = v1 > v2 ? 'lawyer1' : v2 > v1 ? 'lawyer2' : null;
        const winnerName = v1 > v2 ? 'Avocat 1' : v2 > v1 ? 'Avocat 2' : 'Égalité';

        mainArea.innerHTML = `
        <div class="debate-result-screen">
            <div class="debate-result-icon">${winner ? '🏆' : '🤝'}</div>
            <h1 class="debate-result-title">${winner ? winnerName + ' gagne !' : 'Match nul !'}</h1>
            <div class="debate-result-stats">
                <div class="result-stat${winner === 'lawyer1' ? ' winner' : ''}">
                    <div class="stat-name">👔 Avocat 1</div>
                    <div class="stat-value">${v1}</div>
                    ${total > 0 ? `<div class="stat-percent">${Math.round(v1/total*100)}%</div>` : ''}
                </div>
                <div class="result-separator">VS</div>
                <div class="result-stat${winner === 'lawyer2' ? ' winner' : ''}">
                    <div class="stat-name">👔 Avocat 2</div>
                    <div class="stat-value">${v2}</div>
                    ${total > 0 ? `<div class="stat-percent">${Math.round(v2/total*100)}%</div>` : ''}
                </div>
            </div>
            <p class="debate-result-total">${total} spectateur${total > 1 ? 's ont' : ' a'} voté</p>
            <p class="debate-return-info">Retour au lobby dans quelques secondes…</p>
        </div>`;
        interactionArea.innerHTML = '';
    }

    // ============================================
    // UTILITAIRES
    // ============================================

    escapeHTML(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    showDebateToast(message, type = 'info') {
        if (window.app?.showToast) {
            window.app.showToast(message, type);
        }
    }
}

window.DebateModule = DebateModule;
