// ============================================
// Configuration Supabase
// ============================================
// 
// INSTRUCTIONS DE CONFIGURATION:
// 1. CrÃ©er un projet sur https://supabase.com
// 2. RÃ©cupÃ©rer l'URL et la clÃ© anon depuis Project Settings > API
// 3. Remplacer les valeurs ci-dessous
// 4. ExÃ©cuter le script SQL dans l'Ã©diteur SQL Supabase (voir supabase-setup.sql)

const SUPABASE_CONFIG = {
    // Remplacer par votre URL Supabase
    url: 'https://apiisvdmuzwkdklyjruz.supabase.co',
    
    // Remplacer par votre clÃ© anon Supabase
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwaWlzdmRtdXp3a2RrbHlqcnV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MDExOTQsImV4cCI6MjA4NDA3NzE5NH0.ZmAJA7rPaRB_S3YUNU85opUMj6sEZ74JEDaxGq8E9ak',
    
    // Options de configuration
    options: {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        },
        db: {
            schema: 'public'
        }
    }
};

// VÃ©rifier que la configuration est complÃ¨te
if (SUPABASE_CONFIG.url === 'YOUR_SUPABASE_URL' || 
    SUPABASE_CONFIG.anonKey === 'YOUR_SUPABASE_ANON_KEY') {
    console.warn('âš ï¸ Configuration Supabase manquante!');
    console.warn('ðŸ“ Veuillez modifier config.js avec vos identifiants Supabase');
}

// Export pour utilisation dans d'autres fichiers
window.SUPABASE_CONFIG = SUPABASE_CONFIG;