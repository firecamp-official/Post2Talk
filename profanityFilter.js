// ============================================
// Filtre Anti-Insultes et Contenu Préjudiciable
// ============================================
// Module de filtrage avancé avec détection de:
// - Insultes classiques
// - Abréviations (ex: "fdp", "ntm")
// - Substitutions de lettres (ex: "c0n", "m3rd3")
// - Leet speak (ex: "f*ck", "sh!t")
// - Espacements artificiels (ex: "c o n n a r d")

const ProfanityFilter = {
    // Liste des mots interdits (français + variations)
    badWords: [
        // Insultes classiques françaises
        'connard', 'connasse', 'salaud', 'salope', 'putain', 'pute',
        'merde', 'chier', 'enculé', 'enculer', 'pd', 'pédé',
        'con', 'conne', 'débile', 'idiot', 'imbécile', 'crétin',
        'taré', 'abruti', 'naze', 'baltringue', 'boloss',
        'batard', 'bâtard', 'ordure', 'salopard', 'enfoiré',
        'fils de pute', 'fdp', 'ntm', 'ta mère', 'nique',
        'cul', 'bite', 'couille', 'chatte', 'nichon',
        'violer', 'viol', 'nazi', 'hitler', 'terroriste',
        'suicide', 'tuer', 'mort', 'crever',
        
        // Insultes anglaises courantes
        'fuck', 'shit', 'ass', 'bitch', 'damn', 'hell',
        'dick', 'cock', 'pussy', 'nigger', 'fag', 'retard',
        
        // Abréviations et variations
        'wtf', 'stfu', 'gtfo', 'omfg', 'lmfao'
    ],
    
    // Emojis de remplacement amusants
    replacementEmojis: [
        '🌈', '✨', '💫', '🌸', '🌻', '🎈', '🎨', '🎭',
        '🎪', '🎠', '🎡', '🎢', '🎯', '🎲', '🎰', '🏆',
        '🍕', '🍰', '🍪', '🍩', '🍦', '🎂', '☕', '🌮'
    ],
    
    // Normaliser le texte pour détecter les variations
    normalizeText(text) {
        return text
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Enlever accents
            .replace(/[0@]/g, 'o')
            .replace(/[1!|]/g, 'i')
            .replace(/[3]/g, 'e')
            .replace(/[4]/g, 'a')
            .replace(/[5]/g, 's')
            .replace(/[7]/g, 't')
            .replace(/[8]/g, 'b')
            .replace(/[$]/g, 's')
            .replace(/[*]/g, '')
            .replace(/[+]/g, 't')
            .replace(/\s+/g, '') // Enlever espaces
            .replace(/[^a-z]/g, ''); // Garder seulement lettres
    },
    
    // Vérifier si le texte contient des insultes
    containsProfanity(text) {
        if (!text || typeof text !== 'string') return false;
        
        const normalized = this.normalizeText(text);
        const originalLower = text.toLowerCase();
        
        // Vérifier chaque mot interdit
        for (const badWord of this.badWords) {
            const normalizedBadWord = this.normalizeText(badWord);
            
            // Vérification exacte
            if (originalLower.includes(badWord)) {
                return true;
            }
            
            // Vérification normalisée (détecte l33t speak, substitutions)
            if (normalized.includes(normalizedBadWord)) {
                return true;
            }
            
            // Vérifier avec espaces entre lettres (ex: "c o n")
            const spacedPattern = badWord.split('').join('\\s*');
            const spacedRegex = new RegExp(spacedPattern, 'i');
            if (spacedRegex.test(text)) {
                return true;
            }
        }
        
        return false;
    },
    
    // Filtrer et remplacer les insultes par des emojis
    filterText(text) {
        if (!text || typeof text !== 'string') return '';
        
        let filteredText = text;
        const normalized = this.normalizeText(text);
        
        // Parcourir chaque mot interdit
        for (const badWord of this.badWords) {
            const normalizedBadWord = this.normalizeText(badWord);
            
            // Remplacer les occurrences exactes
            const exactRegex = new RegExp(badWord, 'gi');
            if (exactRegex.test(filteredText)) {
                const emoji = this.getRandomEmoji();
                filteredText = filteredText.replace(exactRegex, emoji);
            }
            
            // Remplacer les variantes avec substitutions
            if (normalized.includes(normalizedBadWord)) {
                // Trouver la portion du texte qui correspond
                const matchLength = badWord.length;
                for (let i = 0; i <= filteredText.length - matchLength; i++) {
                    const substring = filteredText.substring(i, i + matchLength + 3);
                    if (this.normalizeText(substring).includes(normalizedBadWord)) {
                        const emoji = this.getRandomEmoji();
                        filteredText = 
                            filteredText.substring(0, i) + 
                            emoji + 
                            filteredText.substring(i + substring.length);
                        break;
                    }
                }
            }
        }
        
        return filteredText;
    },
    
    // Obtenir un emoji aléatoire
    getRandomEmoji() {
        const index = Math.floor(Math.random() * this.replacementEmojis.length);
        return this.replacementEmojis[index];
    },
    
    // Validation complète d'un message
    validateMessage(text) {
        if (!text || typeof text !== 'string') {
            return {
                isValid: false,
                filtered: '',
                reason: 'Message vide'
            };
        }
        
        // Vérifier longueur
        if (text.trim().length === 0) {
            return {
                isValid: false,
                filtered: '',
                reason: 'Message vide'
            };
        }
        
        if (text.length > 120) {
            return {
                isValid: false,
                filtered: text,
                reason: 'Message trop long (max 120 caractères)'
            };
        }
        
        // Vérifier et filtrer les insultes
        const containsBadWords = this.containsProfanity(text);
        const filteredText = this.filterText(text);
        
        // Si trop d'insultes détectées, rejeter
        const emojiCount = (filteredText.match(/[🌈✨💫🌸🌻🎈🎨🎭🎪🎠🎡🎢🎯🎲🎰🏆🍕🍰🍪🍩🍦🎂☕🌮]/g) || []).length;
        if (emojiCount > 3) {
            return {
                isValid: false,
                filtered: filteredText,
                reason: 'Trop de contenu inapproprié détecté'
            };
        }
        
        return {
            isValid: true,
            filtered: filteredText,
            hadProfanity: containsBadWords
        };
    },
    
    // Vérifier contenu préjudiciable (menaces, harcèlement, etc.)
    checkHarmfulContent(text) {
        const harmfulPatterns = [
            /tu vas (mourir|crever|souffrir)/i,
            /je vais te (tuer|buter|crever)/i,
            /(suicide|suicid|se suicid)/i,
            /(terroris|attentat|bombe)/i,
            /(viole|viol|agress)/i,
            /(adresse|où tu habite|je sais où)/i,
            /((numéro|numero) de (téléphone|telephone|tel))/i
        ];
        
        for (const pattern of harmfulPatterns) {
            if (pattern.test(text)) {
                return {
                    isHarmful: true,
                    reason: 'Contenu potentiellement dangereux détecté'
                };
            }
        }
        
        return { isHarmful: false };
    }
};

// Tests automatiques
if (typeof window !== 'undefined') {
    window.ProfanityFilter = ProfanityFilter;
    
    // Tests de validation
    console.log('🧪 Tests du filtre anti-insultes:');
    const tests = [
        'Bonjour tout le monde !',
        'Quel c0n ce type',
        'T es vraiment un fdp',
        'C o n n a r d',
        'F*ck this sh!t',
        'Je vais te tuer',
        'Belle journée ensoleillée'
    ];
    
    tests.forEach(test => {
        const result = ProfanityFilter.validateMessage(test);
        console.log(`"${test}" → Valid: ${result.isValid}, Filtered: "${result.filtered}"`);
    });
}