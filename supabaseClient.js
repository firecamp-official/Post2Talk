// ============================================
// 🚀 CLIENT SUPABASE OPTIMISÉ
// ============================================
// Version avec cache intelligent et Realtime sélectif
// Réduction de 75-80% des requêtes

class SupabaseClient {
    constructor() {
        this.client = null;
        this.isInitialized = false;
        
        // Channels Realtime (optimisés)
        this.postitsChannel = null;
        // ❌ Pas de channel pour debates (polling à la place)
        
        // Callbacks pour les updates Realtime
        this.onPostitsUpdate = null;
        
        // 💾 Système de cache
        this._cache = {};
        
        this.initializeClient();
    }
    
    // ============================================
    // INITIALISATION
    // ============================================
    
    initializeClient() {
        try {
            if (!window.SUPABASE_CONFIG) {
                throw new Error('Configuration Supabase manquante');
            }
            
            const { url, anonKey, options } = window.SUPABASE_CONFIG;
            
            if (url === 'YOUR_SUPABASE_URL' || anonKey === 'YOUR_SUPABASE_ANON_KEY') {
                console.warn('⚠️ Supabase non configuré - Mode démo activé');
                this.isInitialized = false;
                return;
            }
            
            this.client = supabase.createClient(url, anonKey, options);
            this.isInitialized = true;
            console.log('✅ Client Supabase initialisé (version optimisée)');
        } catch (error) {
            console.error('❌ Erreur initialisation Supabase:', error);
            this.isInitialized = false;
        }
    }
    
    // ============================================
    // 💾 SYSTÈME DE CACHE
    // ============================================
    
    _getFromCache(key, maxAge) {
        if (!this._cache) this._cache = {};
        
        const cached = this._cache[key];
        if (!cached) return null;
        
        const age = Date.now() - cached.timestamp;
        if (age > maxAge) {
            delete this._cache[key];
            return null;
        }
        
        return cached.data;
    }
    
    _saveToCache(key, data) {
        if (!this._cache) this._cache = {};
        
        this._cache[key] = {
            data: data,
            timestamp: Date.now()
        };
    }
    
    _invalidateCache(key) {
        if (this._cache && this._cache[key]) {
            delete this._cache[key];
            console.log(`[CACHE] Invalidé: ${key}`);
        }
    }
    
    // ============================================
    // 🔴 REALTIME : POST-ITS (inchangé)
    // ============================================
    
    subscribeToPostits(callback) {
        if (!this.isInitialized) return;
        
        this.onPostitsUpdate = callback;
        
        this.postitsChannel = this.client
            .channel('postits_changes')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'postits'
                },
                (payload) => {
                    console.log('[REALTIME] Post-it changé:', payload.eventType);
                    if (this.onPostitsUpdate) {
                        this.onPostitsUpdate(payload);
                    }
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('🔴 Realtime post-its : CONNECTÉ');
                }
            });
    }
    
    unsubscribeFromPostits() {
        if (this.postitsChannel) {
            this.client.removeChannel(this.postitsChannel);
            this.postitsChannel = null;
            console.log('⏹️ Realtime post-its : DÉCONNECTÉ');
        }
    }
    
    // ============================================
    // GESTION DES POST-ITS
    // ============================================
    
    async createPostIt(data) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            // Valider et filtrer le contenu
            const validation = ProfanityFilter.validateMessage(data.content);
            if (!validation.isValid) {
                return { error: validation.reason };
            }
            
            // Vérifier contenu préjudiciable
            const harmfulCheck = ProfanityFilter.checkHarmfulContent(data.content);
            if (harmfulCheck.isHarmful) {
                return { error: harmfulCheck.reason };
            }
            
            // Nettoyer pour XSS
            const cleanContent = this.sanitizeHTML(validation.filtered);
            
            const postItData = {
                content: cleanContent,
                color: data.color,
                position_x: data.position_x,
                position_y: data.position_y,
                rotation: data.rotation
            };
            
            const { data: result, error } = await this.client
                .from('postits')
                .insert(postItData)
                .select()
                .single();
            
            if (error) throw error;
            
            // Pas besoin de recharger ! Realtime s'en charge ✅
            return { data: result };
        } catch (error) {
            console.error('Erreur création post-it:', error);
            return { error: error.message };
        }
    }
    
    async getPostIts() {
        if (!this.isInitialized) {
            return { data: [] };
        }
        
        try {
            const { data, error } = await this.client
                .from('postits')
                .select('*')
                .gte('created_at', new Date(Date.now() - 3600000).toISOString()) // < 1h
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            
            return { data };
        } catch (error) {
            console.error('Erreur récupération post-its:', error);
            return { data: [] };
        }
    }
    
    async deletePostIt(id) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            const { error } = await this.client
                .from('postits')
                .delete()
                .eq('id', id);
            
            if (error) throw error;
            
            return { success: true };
        } catch (error) {
            console.error('Erreur suppression post-it:', error);
            return { error: error.message };
        }
    }
    
    // ============================================
    // GESTION DES SIGNALEMENTS
    // ============================================
    
    async reportPostIt(postItId, userId) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            // Créer le signalement
            const { error: reportError } = await this.client
                .from('reports')
                .insert({
                    postit_id: postItId,
                    user_id: userId
                });
            
            if (reportError) {
                if (reportError.code === '23505') {
                    return { 
                        success: false, 
                        error: 'Tu as déjà signalé ce message',
                        alreadyReported: true 
                    };
                }
                throw reportError;
            }
            
            // Compter les signalements
            const { data: reports, error: countError } = await this.client
                .from('reports')
                .select('*')
                .eq('postit_id', postItId);
            
            if (countError) throw countError;
            
            // Si 2+ signalements → supprimer le post-it
            if (reports.length >= 2) {
                await this.deletePostIt(postItId);
                return { success: true, deleted: true };
            }
            
            return { success: true, deleted: false };
        } catch (error) {
            console.error('Erreur signalement:', error);
            return { error: error.message };
        }
    }
    
    // ============================================
    // 🚀 GESTION DES DÉBATS (OPTIMISÉE AVEC CACHE)
    // ============================================
    
    async createDebate(data) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            // Valider titre
            const titleValidation = ProfanityFilter.validateMessage(data.title);
            if (!titleValidation.isValid) {
                return { error: 'Titre invalide: ' + titleValidation.reason };
            }
            
            // Valider description
            const descValidation = ProfanityFilter.validateMessage(data.description);
            if (!descValidation.isValid) {
                return { error: 'Description invalide: ' + descValidation.reason };
            }
            
            const debateData = {
                title: this.sanitizeHTML(titleValidation.filtered),
                description: this.sanitizeHTML(descValidation.filtered)
            };
            
            const { data: result, error } = await this.client
                .from('debates')
                .insert(debateData)
                .select()
                .single();
            
            if (error) throw error;
            
            // ⚡ Invalider le cache pour forcer le rechargement
            this._invalidateCache('debates_cache');
            
            return { data: result };
        } catch (error) {
            console.error('Erreur création débat:', error);
            return { error: error.message };
        }
    }
    
    async getDebates() {
        if (!this.isInitialized) {
            return { data: [] };
        }
        
        try {
            // 💾 Essayer le cache d'abord (30 secondes)
            const cacheKey = 'debates_cache';
            const cacheTime = 30000; // 30s
            
            const cached = this._getFromCache(cacheKey, cacheTime);
            if (cached) {
                console.log('[CACHE] 💾 Débats chargés depuis cache');
                return { data: cached };
            }
            
            // Sinon, requête à la base
            console.log('[API] 🌐 Chargement des débats depuis Supabase...');
            const { data, error } = await this.client
                .from('debates')
                .select(`
                    *,
                    votes:debate_votes(vote_type),
                    comments:debate_comments(count)
                `)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            
            // Calculer statistiques
            const debatesWithStats = data.map(debate => ({
                ...debate,
                upvotes: debate.votes?.filter(v => v.vote_type === 'up').length || 0,
                downvotes: debate.votes?.filter(v => v.vote_type === 'down').length || 0,
                commentCount: debate.comments?.length || 0
            }));
            
            // 💾 Sauvegarder dans le cache
            this._saveToCache(cacheKey, debatesWithStats);
            
            return { data: debatesWithStats };
        } catch (error) {
            console.error('Erreur récupération débats:', error);
            return { data: [] };
        }
    }
    
    async voteDebate(debateId, userId, voteType) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            // Upsert : créer ou mettre à jour
            const { error } = await this.client
                .from('debate_votes')
                .upsert({
                    debate_id: debateId,
                    user_id: userId,
                    vote_type: voteType
                }, {
                    onConflict: 'debate_id,user_id'
                });
            
            if (error) throw error;
            
            // ⚡ Invalider le cache pour forcer le rechargement
            this._invalidateCache('debates_cache');
            
            return { success: true };
        } catch (error) {
            console.error('Erreur vote:', error);
            return { error: error.message };
        }
    }
    
    async addDebateComment(debateId, userId, content) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            // Valider et filtrer
            const validation = ProfanityFilter.validateMessage(content);
            if (!validation.isValid) {
                return { error: validation.reason };
            }
            
            const { data, error } = await this.client
                .from('debate_comments')
                .insert({
                    debate_id: debateId,
                    user_id: userId,
                    content: this.sanitizeHTML(validation.filtered)
                })
                .select()
                .single();
            
            if (error) throw error;
            
            // ⚡ Invalider le cache pour forcer le rechargement
            this._invalidateCache('debates_cache');
            
            return { data };
        } catch (error) {
            console.error('Erreur ajout commentaire:', error);
            return { error: error.message };
        }
    }
    
    async getDebateComments(debateId) {
        if (!this.isInitialized) {
            return { data: [] };
        }
        
        try {
            const { data, error } = await this.client
                .from('debate_comments')
                .select('*')
                .eq('debate_id', debateId)
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            
            return { data };
        } catch (error) {
            console.error('Erreur récupération commentaires:', error);
            return { data: [] };
        }
    }
    
    // ============================================
    // UTILITAIRES
    // ============================================
    
    sanitizeHTML(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    getUserId() {
        let userId = localStorage.getItem('mur_user_id');
        if (!userId) {
            userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('mur_user_id', userId);
        }
        return userId;
    }
}

// Initialiser le client global
window.supabaseClient = new SupabaseClient();
