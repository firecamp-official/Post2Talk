// ============================================
// Application Principale - Mur de la Parole
// ============================================

// Gestionnaire Audio
class AudioManager {
    constructor() {
        this.sounds = {};
        this.backgroundMusic = null;
        this.musicVolume = 0.3; // Volume par défaut 30%
        this.sfxVolume = 0.5; // Volume effets sonores 50%
        this.isMusicPlaying = false;
        this.isMuted = false;
        
        this.initAudio();
        this.createAudioControls();
    }
    
    initAudio() {
        // Charger les effets sonores
        const soundEffects = {
            addOpinion: 'soundEffect/addOpinion.mp3',
            afterVoting: 'soundEffect/afterVoting.mp3',
            outZone: 'soundEffect/outZone.mp3',
            reportMessage: 'soundEffect/reportMessage.mp3',
            setPostIt: 'soundEffect/setPostIt.mp3',
            stopMusic: 'soundEffect/stop-music.mp3'
        };
        
        // Créer les objets Audio pour chaque effet
        for (const [key, path] of Object.entries(soundEffects)) {
            try {
                const audio = new Audio(path);
                audio.preload = 'auto';
                audio.volume = this.sfxVolume;
                this.sounds[key] = audio;
            } catch (error) {
                console.warn(`Impossible de charger le son: ${path}`, error);
            }
        }
        
        // Charger la musique de fond
        try {
            this.backgroundMusic = new Audio('backgroundMusic/background.mp3');
            this.backgroundMusic.loop = true;
            this.backgroundMusic.volume = 0; // Commence à 0 pour le fade in
            this.backgroundMusic.preload = 'auto';
        } catch (error) {
            console.warn('Impossible de charger la musique de fond', error);
        }
    }
    
    createAudioControls() {
        // Créer le panneau de contrôle audio
        const controlsHTML = `
            <div class="audio-controls" id="audioControls">
                <button class="audio-btn music-toggle" id="musicToggle" title="Musique de fond">
                    🎵
                </button>
                <div class="volume-controls" id="volumeControls">
                    <div class="volume-group">
                        <label>🎵 Musique</label>
                        <input type="range" id="musicVolume" min="0" max="100" value="30" class="volume-slider">
                        <span id="musicVolumeValue">30%</span>
                    </div>
                    <div class="volume-group">
                        <label>🔊 Effets</label>
                        <input type="range" id="sfxVolume" min="0" max="100" value="50" class="volume-slider">
                        <span id="sfxVolumeValue">50%</span>
                    </div>
                </div>
                <button class="audio-btn mute-toggle" id="muteToggle" title="Couper tous les sons">
                    🔊
                </button>
                <button class="audio-btn toggle-panel" id="togglePanel" title="Masquer les contrôles">
                    ⚙️
                </button>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', controlsHTML);
        
        // Événements des contrôles
        document.getElementById('musicToggle').addEventListener('click', () => this.toggleMusic());
        document.getElementById('muteToggle').addEventListener('click', () => this.toggleMute());
        document.getElementById('musicVolume').addEventListener('input', (e) => this.setMusicVolume(e.target.value));
        document.getElementById('sfxVolume').addEventListener('input', (e) => this.setSfxVolume(e.target.value));
        document.getElementById('togglePanel').addEventListener('click', () => this.togglePanel());
        
        // Démarrer en mode réduit sur mobile
        if (window.app && window.app.isMobile()) {
            setTimeout(() => this.togglePanel(), 100);
        } else if (window.innerWidth < 768) {
            setTimeout(() => this.togglePanel(), 100);
        }
    }
    
    // Toggle visibilité du panneau
    togglePanel() {
        const panel = document.getElementById('audioControls');
        const toggleBtn = document.getElementById('togglePanel');
        const volumeControls = document.getElementById('volumeControls');
        const musicToggle = document.getElementById('musicToggle');
        const muteToggle = document.getElementById('muteToggle');
        
        panel.classList.toggle('collapsed');
        
        if (panel.classList.contains('collapsed')) {
            // Mode réduit : masquer les sliders
            volumeControls.style.display = 'none';
            musicToggle.style.display = 'none';
            muteToggle.style.display = 'none';
            toggleBtn.textContent = '🎚️';
            toggleBtn.title = 'Afficher les contrôles';
        } else {
            // Mode complet : afficher tout
            volumeControls.style.display = 'flex';
            musicToggle.style.display = 'flex';
            muteToggle.style.display = 'flex';
            toggleBtn.textContent = '⚙️';
            toggleBtn.title = 'Masquer les contrôles';
        }
    }
    
    // Jouer un effet sonore
    playSound(soundName) {
        if (this.isMuted || !this.sounds[soundName]) return;
        
        try {
            // Cloner l'audio pour permettre plusieurs lectures simultanées
            const sound = this.sounds[soundName].cloneNode();
            sound.volume = this.sfxVolume;
            
            // Jouer avec gestion d'erreur (autoplay policy)
            const playPromise = sound.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.warn(`Autoplay bloqué pour ${soundName}:`, error);
                });
            }
        } catch (error) {
            console.warn(`Erreur lecture son ${soundName}:`, error);
        }
    }
    
    // Toggle musique de fond
    toggleMusic() {
        if (!this.backgroundMusic) return;
        
        const btn = document.getElementById('musicToggle');
        
        if (this.isMusicPlaying) {
            // Arrêter avec fade out
            this.fadeOut(() => {
                this.backgroundMusic.pause();
                this.isMusicPlaying = false;
                btn.textContent = '🎵';
                btn.classList.remove('playing');
                
                // Jouer le son d'arrêt
                this.playSound('stopMusic');
            });
        } else {
            // Démarrer avec fade in
            this.isMusicPlaying = true;
            btn.textContent = '⏸️';
            btn.classList.add('playing');
            
            const playPromise = this.backgroundMusic.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => this.fadeIn())
                    .catch(error => {
                        console.warn('Autoplay musique bloqué:', error);
                        this.isMusicPlaying = false;
                        btn.textContent = '🎵';
                        btn.classList.remove('playing');
                        
                        // Afficher un message à l'utilisateur
                        if (window.app) {
                            window.app.showToast('Clique à nouveau pour démarrer la musique', 'info');
                        }
                    });
            }
        }
    }
    
    // Fade in de la musique
    fadeIn() {
        if (!this.backgroundMusic) return;
        
        const targetVolume = this.musicVolume;
        const duration = 2000; // 2 secondes
        const steps = 50;
        const increment = targetVolume / steps;
        const interval = duration / steps;
        
        let currentStep = 0;
        const fadeInterval = setInterval(() => {
            if (currentStep >= steps || !this.isMusicPlaying) {
                clearInterval(fadeInterval);
                if (this.isMusicPlaying) {
                    this.backgroundMusic.volume = targetVolume;
                }
                return;
            }
            
            this.backgroundMusic.volume = Math.min(increment * currentStep, targetVolume);
            currentStep++;
        }, interval);
    }
    
    // Fade out de la musique
    fadeOut(callback) {
        if (!this.backgroundMusic) return;
        
        const startVolume = this.backgroundMusic.volume;
        const duration = 1500; // 1.5 secondes
        const steps = 50;
        const decrement = startVolume / steps;
        const interval = duration / steps;
        
        let currentStep = 0;
        const fadeInterval = setInterval(() => {
            if (currentStep >= steps) {
                clearInterval(fadeInterval);
                this.backgroundMusic.volume = 0;
                if (callback) callback();
                return;
            }
            
            this.backgroundMusic.volume = Math.max(startVolume - (decrement * currentStep), 0);
            currentStep++;
        }, interval);
    }
    
    // Définir le volume de la musique
    setMusicVolume(value) {
        this.musicVolume = value / 100;
        document.getElementById('musicVolumeValue').textContent = value + '%';
        
        if (this.backgroundMusic && this.isMusicPlaying) {
            this.backgroundMusic.volume = this.musicVolume;
        }
    }
    
    // Définir le volume des effets sonores
    setSfxVolume(value) {
        this.sfxVolume = value / 100;
        document.getElementById('sfxVolumeValue').textContent = value + '%';
        
        // Mettre à jour le volume de tous les sons
        for (const sound of Object.values(this.sounds)) {
            sound.volume = this.sfxVolume;
        }
    }
    
    // Toggle mute
    toggleMute() {
        this.isMuted = !this.isMuted;
        const btn = document.getElementById('muteToggle');
        
        if (this.isMuted) {
            btn.textContent = '🔇';
            btn.classList.add('muted');
            if (this.backgroundMusic) {
                this.backgroundMusic.muted = true;
            }
        } else {
            btn.textContent = '🔊';
            btn.classList.remove('muted');
            if (this.backgroundMusic) {
                this.backgroundMusic.muted = false;
            }
        }
    }
}

class MurDeParole {
    constructor() {
        this.client = window.supabaseClient;
        this.userId = this.client.getUserId();
        this.currentDebateId = null;
        this.refreshInterval = null;
        this.timerInterval = null;
        this.isDragging = false;
        this.draggedElement = null;
        this.dragOffset = { x: 0, y: 0 };
        
        // Initialiser l'audio
        this.audio = new AudioManager();
        
        // 🎭 Module Débat Live
        this.debateModule = null;
        
        this.init();
    }
    
    // ============================================
    // INITIALISATION
    // ============================================
    
    init() {
        console.log('🎨 Initialisation du Mur de la Parole...');
        
        this.setupEventListeners();
        this.loadPostIts();
        this.loadDebates();
        // Auto-refresh désactivé - utiliser le bouton "Rafraîchir" pour actualiser manuellement
        // this.startAutoRefresh();
        this.updateStatus();
        this.startTimerUpdates(); // Démarrer la mise à jour des timers
        
        // 🎭 Initialiser le module Débat Live
        this.initDebateModule();
        
        console.log('✅ Application prête!');
    }
    
    // ============================================
    // 🎭 MODULE DÉBAT LIVE
    // ============================================
    
    async initDebateModule() {
        // Vérifier que le module est chargé
        if (typeof DebateModule === 'undefined') {
            console.warn('⚠️ Module Débat non chargé - fichier debateModule.js manquant');
            return;
        }
        
        // Attendre que Supabase soit prêt
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        try {
            // Initialiser le module avec nos instances
            this.debateModule = new DebateModule(
                this.client,  // Client Supabase
                this.audio    // Audio Manager
            );
            
            console.log('✅ Module Débat Live initialisé');
        } catch (error) {
            console.error('❌ Erreur initialisation module Débat:', error);
        }
    }
    
    // Configuration des écouteurs d'événements
    setupEventListeners() {
        // Boutons principaux
        document.getElementById('addPostItBtn').addEventListener('click', () => {
            this.openModal('postItModal');
        });
        
        document.getElementById('createDebateBtn').addEventListener('click', () => {
            this.openModal('debateModal');
        });
        
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.refreshAll();
        });
        
        // Fermeture des modals
        document.getElementById('closePostItModal').addEventListener('click', () => {
            this.closeModal('postItModal');
        });
        
        document.getElementById('closeDebateModal').addEventListener('click', () => {
            this.closeModal('debateModal');
        });
        
        document.getElementById('closeDebateInteractModal').addEventListener('click', () => {
            this.closeModal('debateInteractModal');
        });
        
        // Formulaires
        document.getElementById('postItForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handlePostItSubmit();
        });
        
        document.getElementById('debateForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleDebateSubmit();
        });
        
        document.getElementById('debateCommentForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleDebateCommentSubmit();
        });
        
        // Compteur de caractères
        document.getElementById('postItText').addEventListener('input', (e) => {
            document.getElementById('charCount').textContent = e.target.value.length;
        });
        
        // Votes
        document.getElementById('upvoteBtn').addEventListener('click', () => {
            this.handleVote('up');
        });
        
        document.getElementById('downvoteBtn').addEventListener('click', () => {
            this.handleVote('down');
        });
        
        // Fermer modal en cliquant à l'extérieur
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal(modal.id);
                }
            });
        });
        
        // Drag & Drop pour PC
        this.setupDragAndDrop();
        
        // Recalculer les positions au resize de la fenêtre
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                this.repositionPostIts();
            }, 250); // Debounce de 250ms
        });
    }
    
    // Repositionner les post-its qui débordent après un resize
    repositionPostIts() {
        const corkBoard = document.getElementById('corkBoard');
        const boardRect = corkBoard.getBoundingClientRect();
        const postItSize = this.isMobile() ? 140 : 180;
        const margin = 20;
        
        const maxX = Math.max(margin, boardRect.width - postItSize - margin);
        const maxY = Math.max(margin, boardRect.height - postItSize - margin);
        
        document.querySelectorAll('.post-it').forEach(postIt => {
            const currentX = parseFloat(postIt.style.left) || 0;
            const currentY = parseFloat(postIt.style.top) || 0;
            
            // Contraindre si nécessaire
            if (currentX > maxX || currentY > maxY || currentX < margin || currentY < margin) {
                const newX = Math.min(Math.max(margin, currentX), maxX);
                const newY = Math.min(Math.max(margin, currentY), maxY);
                
                postIt.style.left = newX + 'px';
                postIt.style.top = newY + 'px';
            }
        });
    }
    
    // ============================================
    // GESTION DES POST-ITS
    // ============================================
    
    async loadPostIts() {
        const { data: postits } = await this.client.getPostIts();
        
        const corkBoard = document.getElementById('corkBoard');
        const existingPostIts = corkBoard.querySelectorAll('.post-it');
        existingPostIts.forEach(el => el.remove());
        
        if (postits && postits.length > 0) {
            corkBoard.classList.add('has-postits');
            postits.forEach(postit => this.renderPostIt(postit));
            
            // Recalculer les positions après le rendu
            setTimeout(() => this.repositionPostIts(), 100);
            
            // Afficher les 3 derniers messages
            this.updateRecentMessages(postits);
        } else {
            corkBoard.classList.remove('has-postits');
            this.updateRecentMessages([]);
        }
    }
    
    // Mettre à jour la section des 3 derniers messages
    updateRecentMessages(postits) {
        const container = document.getElementById('recentMessagesContainer');
        
        if (!postits || postits.length === 0) {
            container.innerHTML = '<div class="recent-message-placeholder">Aucun message récent...</div>';
            return;
        }
        
        // Prendre les 3 derniers (déjà triés par created_at DESC)
        const recent = postits.slice(0, 3);
        
        container.innerHTML = '';
        
        recent.forEach((postit, index) => {
            const card = document.createElement('div');
            card.className = 'recent-message-card';
            card.dataset.id = postit.id;
            card.style.animationDelay = `${index * 0.1}s`;
            
            const timeAgo = this.timeAgo(postit.created_at);
            const timeRemaining = this.getTimeRemaining(postit.created_at);
            
            card.innerHTML = `
                <div class="recent-message-content">${postit.content}</div>
                <div class="recent-message-meta">
                    <span class="recent-message-time">Il y a ${timeAgo}</span>
                    <span class="recent-message-timer">⏱️ ${timeRemaining}</span>
                </div>
            `;
            
            // Cliquer pour scroller vers le post-it sur le tableau
            card.addEventListener('click', () => {
                this.scrollToPostIt(postit.id);
            });
            
            container.appendChild(card);
        });
    }
    
    // Scroller vers un post-it spécifique sur le tableau
    scrollToPostIt(postItId) {
        const postIt = document.querySelector(`.post-it[data-id="${postItId}"]`);
        if (!postIt) return;
        
        // Effet flash pour attirer l'attention
        postIt.style.animation = 'none';
        setTimeout(() => {
            postIt.style.animation = 'flashHighlight 1s ease-out';
        }, 10);
        
        // Scroller vers le post-it
        postIt.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center',
            inline: 'center'
        });
    }
    
    renderPostIt(postit) {
        const corkBoard = document.getElementById('corkBoard');
        const boardRect = corkBoard.getBoundingClientRect();
        
        // Taille du post-it selon l'écran
        const postItSize = this.isMobile() ? 140 : 180;
        
        // Contraindre la position dans les limites du tableau
        const maxX = Math.max(20, boardRect.width - postItSize - 20);
        const maxY = Math.max(20, boardRect.height - postItSize - 20);
        
        const constrainedX = Math.min(Math.max(20, postit.position_x), maxX);
        const constrainedY = Math.min(Math.max(20, postit.position_y), maxY);
        
        // Calculer le temps restant
        const timeRemaining = this.getTimeRemaining(postit.created_at);
        
        const postItEl = document.createElement('div');
        postItEl.className = 'post-it';
        postItEl.dataset.id = postit.id;
        postItEl.dataset.createdAt = postit.created_at;
        postItEl.style.backgroundColor = postit.color;
        postItEl.style.left = constrainedX + 'px';
        postItEl.style.top = constrainedY + 'px';
        postItEl.style.transform = `rotate(${postit.rotation}deg)`;
        postItEl.style.setProperty('--rotation', `${postit.rotation}deg`);
        
        postItEl.innerHTML = `
            <div class="post-it-pin">📌</div>
            <div class="post-it-content">${postit.content}</div>
            <div class="post-it-timer" data-timer="${postit.id}">
                ⏱️ ${timeRemaining}
            </div>
            <div class="post-it-actions">
                <button class="post-it-btn report-btn" title="Signaler" data-id="${postit.id}">
                    🚩
                </button>
            </div>
        `;
        
        // Mobile: tap pour déplacer
        if (this.isMobile()) {
            postItEl.style.cursor = 'pointer';
            postItEl.addEventListener('click', (e) => {
                if (!e.target.classList.contains('post-it-btn')) {
                    this.movePostItMobile(postItEl);
                }
            });
        } else {
            // Desktop: drag & drop
            postItEl.draggable = true;
            postItEl.addEventListener('dragstart', (e) => this.handleDragStart(e));
            postItEl.addEventListener('dragend', (e) => this.handleDragEnd(e));
        }
        
        // Signalement
        const reportBtn = postItEl.querySelector('.report-btn');
        reportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleReport(postit.id);
        });
        
        corkBoard.appendChild(postItEl);
    }
    
    async handlePostItSubmit() {
        const content = document.getElementById('postItText').value.trim();
        const color = document.querySelector('input[name="color"]:checked').value;
        
        if (!content) {
            this.showToast('Le message ne peut pas être vide', 'error');
            return;
        }
        
        // Position aléatoire DANS le tableau avec marges de sécurité
        const corkBoard = document.getElementById('corkBoard');
        const boardRect = corkBoard.getBoundingClientRect();
        
        // Taille du post-it selon l'écran
        const postItSize = this.isMobile() ? 140 : 180;
        const margin = 20;
        
        // Calculer l'espace disponible
        const availableWidth = Math.max(postItSize, boardRect.width - postItSize - (margin * 2));
        const availableHeight = Math.max(postItSize, boardRect.height - postItSize - (margin * 2));
        
        const position_x = Math.random() * availableWidth + margin;
        const position_y = Math.random() * availableHeight + margin;
        const rotation = (Math.random() - 0.5) * 10; // -5 à +5 degrés
        
        const postItData = {
            content,
            color,
            position_x,
            position_y,
            rotation
        };
        
        const result = await this.client.createPostIt(postItData);
        
        if (result.error) {
            this.showToast('Erreur: ' + result.error, 'error');
            return;
        }
        
        this.showToast('Post-it ajouté ! 🎉', 'success');
        this.closeModal('postItModal');
        document.getElementById('postItForm').reset();
        document.getElementById('charCount').textContent = '0';
        
        await this.loadPostIts();
        this.audio.playSound('setPostIt'); // Son d'ajout de post-it
    }
    
    async handleReport(postItId) {
        if (!confirm('Signaler ce post-it comme inapproprié ?')) {
            return;
        }
        
        const result = await this.client.reportPostIt(postItId, this.userId);
        
        if (result.error) {
            this.showToast('Erreur: ' + result.error, 'error');
            return;
        }
        
        if (result.deleted) {
            this.showToast('Post-it supprimé après signalements', 'info');
            await this.loadPostIts();
        } else {
            this.showToast('Signalement enregistré', 'success');
        }
        
        this.audio.playSound('reportMessage'); // Son de signalement
    }
    
    // ============================================
    // DRAG & DROP (PC)
    // ============================================
    
    setupDragAndDrop() {
        const corkBoard = document.getElementById('corkBoard');
        
        corkBoard.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        
        corkBoard.addEventListener('drop', (e) => {
            e.preventDefault();
            this.handleDrop(e);
        });
    }
    
    handleDragStart(e) {
        this.isDragging = true;
        this.draggedElement = e.target;
        e.target.classList.add('dragging');
        
        const rect = e.target.getBoundingClientRect();
        this.dragOffset.x = e.clientX - rect.left;
        this.dragOffset.y = e.clientY - rect.top;
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', e.target.innerHTML);
    }
    
    handleDragEnd(e) {
        this.isDragging = false;
        e.target.classList.remove('dragging');
    }
    
    handleDrop(e) {
        if (!this.draggedElement) return;
        
        const corkBoard = document.getElementById('corkBoard');
        const boardRect = corkBoard.getBoundingClientRect();
        
        // Calculer nouvelle position
        const x = e.clientX - boardRect.left - this.dragOffset.x;
        const y = e.clientY - boardRect.top - this.dragOffset.y;
        
        // Vérifier si dans la zone du tableau
        if (this.isInBounds(x, y, boardRect)) {
            this.draggedElement.style.left = x + 'px';
            this.draggedElement.style.top = y + 'px';
            this.audio.playSound('setPostIt'); // Son de placement réussi
        } else {
            this.showToast('Post-it en dehors du tableau !', 'error');
            this.audio.playSound('outZone'); // Son hors zone
        }
        
        this.draggedElement = null;
    }
    
    // ============================================
    // MOBILE: TAP TO PLACE
    // ============================================
    
    movePostItMobile(postItEl) {
        const corkBoard = document.getElementById('corkBoard');
        const boardRect = corkBoard.getBoundingClientRect();
        
        // Taille du post-it selon l'écran
        const postItSize = this.isMobile() ? 140 : 180;
        const margin = 20;
        
        // Nouvelle position aléatoire DANS les limites
        const availableWidth = Math.max(postItSize, boardRect.width - postItSize - (margin * 2));
        const availableHeight = Math.max(postItSize, boardRect.height - postItSize - (margin * 2));
        
        const x = Math.random() * availableWidth + margin;
        const y = Math.random() * availableHeight + margin;
        
        postItEl.style.left = x + 'px';
        postItEl.style.top = y + 'px';
        
        // Animation de rebond
        postItEl.style.animation = 'none';
        setTimeout(() => {
            postItEl.style.animation = 'popIn 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
        }, 10);
        
        this.audio.playSound('setPostIt'); // Son de déplacement
    }
    
    // ============================================
    // GESTION DES DÉBATS
    // ============================================
    
    async loadDebates() {
        const { data: debates } = await this.client.getDebates();
        
        const container = document.getElementById('debatesContainer');
        container.innerHTML = '';
        
        if (!debates || debates.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: white; font-size: 18px;">Aucun débat pour le moment. Sois le premier à en créer un ! 🚀</p>';
            return;
        }
        
        debates.forEach(debate => this.renderDebate(debate));
    }
    
    renderDebate(debate) {
        const container = document.getElementById('debatesContainer');
        
        const debateEl = document.createElement('div');
        debateEl.className = 'debate-bubble';
        debateEl.dataset.id = debate.id;
        
        debateEl.innerHTML = `
            <h3 class="debate-title">${debate.title}</h3>
            <p class="debate-desc">${debate.description}</p>
            <div class="debate-stats">
                <span class="debate-stat">👍 ${debate.upvotes || 0}</span>
                <span class="debate-stat">👎 ${debate.downvotes || 0}</span>
                <span class="debate-stat">💬 ${debate.commentCount || 0}</span>
            </div>
        `;
        
        debateEl.addEventListener('click', () => {
            this.openDebateInteraction(debate.id);
        });
        
        container.appendChild(debateEl);
    }
    
    async handleDebateSubmit() {
        const title = document.getElementById('debateTitle').value.trim();
        const description = document.getElementById('debateDesc').value.trim();
        
        if (!title || !description) {
            this.showToast('Tous les champs sont requis', 'error');
            return;
        }
        
        const result = await this.client.createDebate({ title, description });
        
        if (result.error) {
            this.showToast('Erreur: ' + result.error, 'error');
            return;
        }
        
        this.showToast('Débat créé ! 🎉', 'success');
        this.closeModal('debateModal');
        document.getElementById('debateForm').reset();
        
        await this.loadDebates();
        this.audio.playSound('setPostIt'); // Son de création
    }
    
    async openDebateInteraction(debateId) {
        this.currentDebateId = debateId;
        
        // Charger les données du débat
        const { data: debates } = await this.client.getDebates();
        const debate = debates.find(d => d.id === debateId);
        
        if (!debate) return;
        
        document.getElementById('debateInteractTitle').textContent = debate.title;
        document.getElementById('debateInteractDesc').textContent = debate.description;
        document.getElementById('upvoteCount').textContent = debate.upvotes || 0;
        document.getElementById('downvoteCount').textContent = debate.downvotes || 0;
        
        // Charger les commentaires
        await this.loadDebateComments(debateId);
        
        this.openModal('debateInteractModal');
    }
    
    async loadDebateComments(debateId) {
        const { data: comments } = await this.client.getDebateComments(debateId);
        
        const container = document.getElementById('debateComments');
        container.innerHTML = '';
        
        if (!comments || comments.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #999;">Aucun commentaire. Sois le premier à donner ton avis !</p>';
            return;
        }
        
        comments.forEach(comment => {
            const commentEl = document.createElement('div');
            commentEl.className = 'comment';
            
            const timeAgo = this.timeAgo(comment.created_at);
            
            commentEl.innerHTML = `
                <p class="comment-text">${comment.content}</p>
                <div class="comment-meta">Il y a ${timeAgo}</div>
            `;
            
            container.appendChild(commentEl);
        });
    }
    
    async handleVote(voteType) {
        if (!this.currentDebateId) return;
        
        const result = await this.client.voteDebate(
            this.currentDebateId,
            this.userId,
            voteType
        );
        
        if (result.error) {
            this.showToast('Erreur: ' + result.error, 'error');
            return;
        }
        
        this.showToast('Vote enregistré !', 'success');
        
        // Recharger les stats
        await this.openDebateInteraction(this.currentDebateId);
        await this.loadDebates();
        
        this.audio.playSound('afterVoting'); // Son après vote
    }
    
    async handleDebateCommentSubmit() {
        const content = document.getElementById('debateComment').value.trim();
        
        if (!content) {
            this.showToast('Le commentaire ne peut pas être vide', 'error');
            return;
        }
        
        const result = await this.client.addDebateComment(
            this.currentDebateId,
            this.userId,
            content
        );
        
        if (result.error) {
            this.showToast('Erreur: ' + result.error, 'error');
            return;
        }
        
        this.showToast('Commentaire ajouté ! 💬', 'success');
        document.getElementById('debateComment').value = '';
        
        await this.loadDebateComments(this.currentDebateId);
        await this.loadDebates();
        
        this.audio.playSound('addOpinion'); // Son d'ajout d'opinion
    }
    
    // ============================================
    // UTILITAIRES
    // ============================================
    
    openModal(modalId) {
        document.getElementById(modalId).classList.add('active');
    }
    
    closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');
    }
    
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'toastSlideIn 0.4s reverse';
            setTimeout(() => toast.remove(), 400);
        }, 3000);
    }
    
    async refreshAll() {
        this.showToast('Actualisation...', 'info');
        await this.loadPostIts();
        await this.loadDebates();
        this.updateStatus();
    }
    
    // Fonction désactivée - refresh uniquement manuel via le bouton
    // startAutoRefresh() {
    //     // Rafraîchir toutes les 5 secondes
    //     this.refreshInterval = setInterval(() => {
    //         this.loadPostIts();
    //         this.loadDebates();
    //     }, 5000);
    // }
    
    updateStatus() {
        const statusText = document.getElementById('statusText');
        const statusIndicator = document.querySelector('.status-indicator');
        
        if (this.client.isInitialized) {
            statusText.textContent = 'En ligne';
            statusIndicator.classList.remove('offline');
        } else {
            statusText.textContent = 'Mode démo';
            statusIndicator.classList.add('offline');
        }
    }
    
    isInBounds(x, y, boardRect) {
        const postItSize = this.isMobile() ? 140 : 180;
        const margin = 10; // Petite marge de tolérance
        
        return x >= -margin && 
               y >= -margin && 
               x <= (boardRect.width - postItSize + margin) && 
               y <= (boardRect.height - postItSize + margin);
    }
    
    isMobile() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }
    
    timeAgo(dateString) {
        const now = new Date();
        const past = new Date(dateString);
        const diffMs = now - past;
        
        const minutes = Math.floor(diffMs / 60000);
        if (minutes < 60) return `${minutes}min`;
        
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h`;
        
        const days = Math.floor(hours / 24);
        return `${days}j`;
    }
    
    // Calculer le temps restant avant suppression
    getTimeRemaining(createdAt) {
        const created = new Date(createdAt);
        const now = new Date();
        const expiresAt = new Date(created.getTime() + (60 * 60 * 1000)); // 60 minutes = 1 heure
        
        const remaining = expiresAt - now;
        
        if (remaining <= 0) {
            return '0min';
        }
        
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        
        if (minutes > 0) {
            return `${minutes}min`;
        } else {
            return `${seconds}s`;
        }
    }
    
    // Mettre à jour tous les timers
    updateTimers() {
        // Mettre à jour les timers sur le tableau
        document.querySelectorAll('.post-it-timer').forEach(timer => {
            const postIt = timer.closest('.post-it');
            if (!postIt) return;
            
            const createdAt = postIt.dataset.createdAt;
            if (!createdAt) return;
            
            const timeRemaining = this.getTimeRemaining(createdAt);
            const created = new Date(createdAt);
            const now = new Date();
            const minutesElapsed = (now - created) / 60000;
            
            // Mettre à jour le texte
            timer.innerHTML = `⏱️ ${timeRemaining}`;
            
            // Changer la couleur selon le temps restant
            // Pour 1 heure (60 min):
            // Warning: moins de 15 min restantes (45+ min écoulées)
            // Critical: moins de 5 min restantes (55+ min écoulées)
            if (minutesElapsed > 55) {
                timer.classList.add('critical'); // Moins de 5 min
            } else if (minutesElapsed > 45) {
                timer.classList.add('warning'); // Moins de 15 min
            } else {
                timer.classList.remove('warning', 'critical');
            }
            
            // Faire disparaître avec animation si expiré
            if (minutesElapsed >= 60) {
                postIt.style.animation = 'fadeOutScale 0.5s forwards';
                setTimeout(() => postIt.remove(), 500);
            }
        });
        
        // Mettre à jour les timers dans les cartes récentes
        document.querySelectorAll('.recent-message-timer').forEach(timer => {
            const card = timer.closest('.recent-message-card');
            if (!card) return;
            
            const postItId = card.dataset.id;
            const postIt = document.querySelector(`.post-it[data-id="${postItId}"]`);
            if (!postIt) return;
            
            const createdAt = postIt.dataset.createdAt;
            if (!createdAt) return;
            
            const timeRemaining = this.getTimeRemaining(createdAt);
            timer.innerHTML = `⏱️ ${timeRemaining}`;
        });
    }
    
    // Démarrer la mise à jour des timers
    startTimerUpdates() {
        // Mettre à jour toutes les secondes
        this.timerInterval = setInterval(() => {
            this.updateTimers();
        }, 1000);
    }
}

// ============================================
// INITIALISATION GLOBALE
// ============================================

// Attendre que le DOM soit chargé
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.app = new MurDeParole();
    });
} else {
    window.app = new MurDeParole();
}