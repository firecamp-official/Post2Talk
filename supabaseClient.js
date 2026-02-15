// ============================================
// Client Supabase avec gestion RLS
// ============================================

class SupabaseClient {
    constructor() {
        this.client = null;
        this.isInitialized = false;
        this.initializeClient();
    }
    
    // Initialiser le client Supabase
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
            console.log('✅ Client Supabase initialisé');
        } catch (error) {
            console.error('❌ Erreur initialisation Supabase:', error);
            this.isInitialized = false;
        }
    }
    
    // ============================================
    // GESTION DES POST-ITS
    // ============================================
    
    // Créer un nouveau post-it
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
                rotation: data.rotation,
                created_at: new Date().toISOString()
            };
            
            const { data: result, error } = await this.client
                .from('postits')
                .insert(postItData)
                .select()
                .single();
            
            if (error) throw error;
            
            return { data: result };
        } catch (error) {
            console.error('Erreur création post-it:', error);
            return { error: error.message };
        }
    }
    
    // Récupérer tous les post-its
    async getPostIts() {
        if (!this.isInitialized) {
            return { data: [] };
        }
        
        try {
            const { data, error } = await this.client
                .from('postits')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            
            // Filtrer les post-its expirés (>1h)
            const validPostIts = data.filter(postit => {
                const createdAt = new Date(postit.created_at);
                const now = new Date();
                const hoursDiff = (now - createdAt) / (1000 * 60 * 60);
                return hoursDiff < 1; // Moins d'1 heure
            });
            
            return { data: validPostIts };
        } catch (error) {
            console.error('Erreur récupération post-its:', error);
            return { data: [] };
        }
    }
    
    // Supprimer un post-it
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
    
    // Signaler un post-it
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
                    user_id: userId,
                    created_at: new Date().toISOString()
                });
            
            if (reportError) throw reportError;
            
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
    // GESTION DES DÉBATS
    // ============================================
    
    // Créer un débat
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
                description: this.sanitizeHTML(descValidation.filtered),
                created_at: new Date().toISOString()
            };
            
            const { data: result, error } = await this.client
                .from('debates')
                .insert(debateData)
                .select()
                .single();
            
            if (error) throw error;
            
            return { data: result };
        } catch (error) {
            console.error('Erreur création débat:', error);
            return { error: error.message };
        }
    }
    
    // Récupérer tous les débats
    async getDebates() {
        if (!this.isInitialized) {
            return { data: [] };
        }
        
        try {
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
            
            return { data: debatesWithStats };
        } catch (error) {
            console.error('Erreur récupération débats:', error);
            return { data: [] };
        }
    }
    
    // Voter sur un débat
    async voteDebate(debateId, userId, voteType) {
        if (!this.isInitialized) {
            return { error: 'Supabase non initialisé' };
        }
        
        try {
            // Vérifier si déjà voté
            const { data: existingVote } = await this.client
                .from('debate_votes')
                .select('*')
                .eq('debate_id', debateId)
                .eq('user_id', userId)
                .single();
            
            if (existingVote) {
                // Mettre à jour le vote
                const { error } = await this.client
                    .from('debate_votes')
                    .update({ vote_type: voteType })
                    .eq('debate_id', debateId)
                    .eq('user_id', userId);
                
                if (error) throw error;
            } else {
                // Créer nouveau vote
                const { error } = await this.client
                    .from('debate_votes')
                    .insert({
                        debate_id: debateId,
                        user_id: userId,
                        vote_type: voteType,
                        created_at: new Date().toISOString()
                    });
                
                if (error) throw error;
            }
            
            return { success: true };
        } catch (error) {
            console.error('Erreur vote:', error);
            return { error: error.message };
        }
    }
    
    // Ajouter un commentaire à un débat
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
                    content: this.sanitizeHTML(validation.filtered),
                    created_at: new Date().toISOString()
                })
                .select()
                .single();
            
            if (error) throw error;
            
            return { data };
        } catch (error) {
            console.error('Erreur ajout commentaire:', error);
            return { error: error.message };
        }
    }
    
    // Récupérer les commentaires d'un débat
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
    
    // Nettoyer HTML pour prévenir XSS
    sanitizeHTML(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Générer un ID utilisateur unique (stocké en localStorage)
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