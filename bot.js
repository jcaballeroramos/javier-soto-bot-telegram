// =============================================================================
// ==                       JAVIER SOTO TELEGRAM BOT                          ==
// =============================================================================
// == Autor: Artefacto (Jorge Caballero)                                      ==
// == Descripción: Bot de Telegram que simula ser Javier Soto, interactuando  ==
// ==              con Claude y generando/transformando voz con ElevenLabs.   ==
// =============================================================================

// -----------------------------------------------------------------------------
// -- 1. Dependencias e Inicialización de Entorno                             --
// -----------------------------------------------------------------------------

// Cargar variables de entorno desde el archivo .env
require('dotenv').config();

// Importar módulos necesarios
const { Telegraf } = require('telegraf');        // Framework del bot de Telegram
const Anthropic = require('@anthropic-ai/sdk').default; // Cliente oficial de Anthropic (Claude)
const axios = require('axios');                // Para solicitudes HTTP (ElevenLabs API, descargas de Telegram)
const fs = require('fs');                      // Módulo File System (para manejar archivos temporales)
const path = require('path');                  // Módulo Path (para construir rutas de archivos)
const os = require('os');                      // Módulo OS (para obtener directorio temporal del sistema)
const FormData = require('form-data');         // Para requests multipart/form-data (V2V)

// -----------------------------------------------------------------------------
// -- 2. Logger Personalizado                                                 --
// -----------------------------------------------------------------------------

/**
 * Clase Logger para un logging estructurado y con timestamps.
 */
class Logger {
  static _log(level, message, error = null) {
    const timestamp = new Date().toISOString();
    console[level.toLowerCase()](`[${timestamp}] ${level}: ${message}`);
    if (error) {
      console[level.toLowerCase()](`  | Details: ${error.message}`);
      if (error.response) {
        console[level.toLowerCase()](`  | Status: ${error.response.status} ${error.response.statusText || ''}`);
        let errorData = error.response.data;
        // Intentar decodificar si es un buffer (común en respuestas de error binarias o JSON)
        if (Buffer.isBuffer(errorData)) {
          try { errorData = JSON.parse(errorData.toString()); }
          catch (e) { errorData = errorData.toString(); /* Mostrar como texto si no es JSON */ }
        }
        console[level.toLowerCase()](`  | Data:`, errorData);
      } else if (error.stack) {
        // Mostrar stack trace para errores no relacionados con HTTP
        console[level.toLowerCase()](`  | Stack: ${error.stack.split('\n').slice(1).join('\n')}`); // Omitir la primera línea (el mensaje)
      }
    }
  }

  static log(message)   { this._log('INFO', message); }
  static error(message, error) { this._log('ERROR', message, error); }
  static warn(message)  { this._log('WARN', message); }
  static debug(title, obj) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] DEBUG: ${title}:`);
    try {
      console.log(JSON.stringify(obj, null, 2)); // Formato JSON indentado para legibilidad
    } catch (e) {
      console.log(obj); // Fallback si no se puede stringificar
    }
  }
}

// -----------------------------------------------------------------------------
// -- 3. Configuración Global                                                 --
// -----------------------------------------------------------------------------

const CONFIG = {
  /** Configuraciones del Bot de Telegram y timeouts */
  BOT: {
    TIMEOUT: 120000,         // Timeout general para los handlers de Telegraf (ms)
    TELEGRAM_TIMEOUT: 60000, // Timeout para llamadas a la API de Telegram (ms)
    MAX_RETRIES: 3,          // Máximo de reintentos para operaciones fallidas (APIs)
    RETRY_DELAY: 5000,       // Delay base antes del primer reintento (ms)
  },
  /** Configuraciones para Claude (Anthropic) */
  CLAUDE: {
    MODEL: "claude-sonnet-4-6", // Modelo de Claude a usar
    MAX_TOKENS: 500             // Límite de tokens en la respuesta generada
  },
  /** Configuraciones para ElevenLabs */
  ELEVEN_LABS: {
    // Intentar obtener el Voice ID desde .env, si no, usar el default
    VOICE_ID: process.env.ELEVEN_VOICE_ID || "D7SBnF4n4o91eIeXkdar", // Voz de Javier Soto HQ
    MODEL: "eleven_multilingual_v2",       // Modelo TTS (Text-to-Speech)
    STS_MODEL: "eleven_multilingual_sts_v2", // Modelo STS (Speech-to-Speech) para V2V
    // Parámetros por defecto para la generación de voz (TTS y STS)
    STABILITY: 0.30,        // Rango: 0.0 (más estable) a 1.0 (más variable)
    SIMILARITY_BOOST: 1.0,  // Rango: 0.0 a 1.0 (fuerza la similitud con la voz original)
    STYLE: 0.7,             // Rango: >= 0.0 (intensidad del estilo/exageración)
    SPEED: 1.0,             // Rango: 0.5 (lento) a 2.0 (rápido)
    USE_SPEAKER_BOOST: true,// Mejora la claridad y estabilidad de la voz generada
    OUTPUT_FORMAT: "mp3_44100_128" // Formato de salida de audio (codec_samplerate_bitrate)
  },
  /** Directorio para archivos temporales (audio descargado/generado) */
  TMP_DIR: path.join(os.tmpdir(), 'javier-bot')
};

// --- Crear directorio temporal si no existe ---
try {
  if (!fs.existsSync(CONFIG.TMP_DIR)) {
    fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    Logger.log(`Directorio temporal creado: ${CONFIG.TMP_DIR}`);
  } else {
    Logger.log(`Directorio temporal ya existe: ${CONFIG.TMP_DIR}`);
  }
} catch (error) {
  Logger.error(`Error crítico creando directorio temporal principal: ${CONFIG.TMP_DIR}`, error);
  // Intentar usar un directorio local como respaldo
  const fallbackTmpDir = path.join(__dirname, 'tmp_javier_bot'); // Usar nombre específico
  try {
    if (!fs.existsSync(fallbackTmpDir)) {
      fs.mkdirSync(fallbackTmpDir, { recursive: true });
    }
    CONFIG.TMP_DIR = fallbackTmpDir;
    Logger.log(`Usando directorio temporal de respaldo: ${CONFIG.TMP_DIR}`);
  } catch (fallbackError) {
    Logger.error(`Error crítico creando directorio temporal de respaldo: ${fallbackTmpDir}`, fallbackError);
    Logger.error("No se pudo crear NINGÚN directorio temporal. El bot no puede continuar.");
    process.exit(1); // Salir si no hay directorio temporal
  }
}

// -----------------------------------------------------------------------------
// -- 4. Inicialización de Clientes de API                                    --
// -----------------------------------------------------------------------------

// --- Cliente Anthropic (Claude) ---
let anthropic = null; // Inicializar como null
try {
  // Solo inicializar si la API Key está presente en .env
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    Logger.log("Cliente Anthropic (Claude) inicializado correctamente.");
  } else {
    Logger.warn("ANTHROPIC_API_KEY no encontrada en .env. Funcionalidad de chat con IA estará deshabilitada.");
  }
} catch (error) {
  Logger.error("Error durante la inicialización del cliente Anthropic", error);
}

// Flag global para indicar si ElevenLabs está disponible (se verifica al inicio)
let elevenLabsAvailable = false;

// -----------------------------------------------------------------------------
// -- 5. Utilidades Generales                                                 --
// -----------------------------------------------------------------------------

/**
 * Clase con funciones de utilidad reutilizables.
 */
class Utils {
  /**
   * Reintenta una función asíncrona en caso de fallo.
   * @param {Function} fn - La función asíncrona a ejecutar.
   * @param {number} maxRetries - Número máximo de reintentos.
   * @param {number} delay - Delay base antes del primer reintento (ms). Usa backoff exponencial.
   * @returns {Promise<any>} - La promesa resuelta por la función `fn`.
   * @throws {Error} - El último error ocurrido si todos los reintentos fallan.
   */
  static async retry(fn, maxRetries = CONFIG.BOT.MAX_RETRIES, delay = CONFIG.BOT.RETRY_DELAY) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Logger.log(`Utils.retry: Intento ${i + 1}/${maxRetries}...`); // Puede ser muy verboso
        return await fn(); // Ejecutar la función
      } catch (error) {
        lastError = error;
        Logger.warn(`Utils.retry: Intento ${i + 1} fallido: ${error.message}`);
        if (i < maxRetries - 1) {
          // Calcular delay con backoff exponencial
          const waitTime = delay * Math.pow(2, i);
          // Logger.log(`Utils.retry: Esperando ${waitTime}ms antes de reintentar...`); // Verboso
          await new Promise(resolve => setTimeout(resolve, waitTime)); // Esperar
        }
      }
    }
    // Si todos los reintentos fallan, lanzar el último error capturado
    Logger.error(`Utils.retry: Todos los ${maxRetries} intentos fallaron.`);
    throw lastError;
  }

  /**
   * Valida la presencia de variables de entorno esenciales.
   * @returns {boolean} - `true` si todas las variables requeridas están presentes, `false` si falta alguna.
   */
  static validateEnvVars() {
    const required = ['BOT_TOKEN', 'AUTHORIZED_USERS'];
    const missing = [];

    // Verificar variables requeridas
    for (const key of required) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }

    // Avisar sobre opcionales faltantes pero no marcar como error
    if (!process.env.ANTHROPIC_API_KEY) {
        Logger.warn("Utils.validateEnvVars: ANTHROPIC_API_KEY no definida (chat con IA deshabilitado).");
    }
    if (!process.env.ELEVEN_API_KEY) {
        Logger.warn("Utils.validateEnvVars: ELEVEN_API_KEY no definida (funcionalidad de voz deshabilitada).");
    }
    if (!process.env.ELEVEN_VOICE_ID) {
        Logger.warn(`Utils.validateEnvVars: ELEVEN_VOICE_ID no definida (usando default: ${CONFIG.ELEVEN_LABS.VOICE_ID}).`);
    }

    // Si faltan variables requeridas, loguear error y devolver false
    if (missing.length > 0) {
      Logger.error(`Utils.validateEnvVars: Faltan variables de entorno OBLIGATORIAS: ${missing.join(', ')}`);
      return false;
    }

    Logger.log("Utils.validateEnvVars: Variables de entorno requeridas verificadas.");
    return true;
  }
}

// -----------------------------------------------------------------------------
// -- 6. Gestor de Estado del Bot                                             --
// -----------------------------------------------------------------------------

/**
 * Gestiona el estado de las interacciones de los usuarios, autorizaciones,
 * conversaciones y operaciones pendientes.
 */
class StateManager {
  constructor() {
    this.initializeState();
  }

  /** Inicializa las estructuras de datos del estado */
  initializeState() {
    Logger.log("StateManager: Inicializando estado...");

    // --- Usuarios Autorizados y Administradores ---
    try {
      // Cargar IDs desde .env, convertir a números y filtrar NaN
      const parseIds = (envVar) => envVar
        ? envVar.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
        : [];

      this.authorizedUsers = new Set(parseIds(process.env.AUTHORIZED_USERS));
      this.adminUsers = new Set(parseIds(process.env.ADMIN_USERS)); // Para futuras funciones de admin

      // Loguear información importante sobre usuarios
      if (this.authorizedUsers.size === 0) {
          Logger.warn("StateManager: ¡ATENCIÓN! No se definieron usuarios autorizados en AUTHORIZED_USERS. Nadie podrá usar el bot.");
      } else {
          Logger.log(`StateManager: Usuarios autorizados cargados: ${Array.from(this.authorizedUsers).join(', ')}`);
      }
      Logger.log(`StateManager: Usuarios administradores cargados: ${Array.from(this.adminUsers).join(', ')}`);

    } catch (error) {
      Logger.error("StateManager: Error crítico procesando usuarios autorizados/admin desde .env", error);
      // Inicializar vacíos para evitar errores posteriores
      this.authorizedUsers = new Set();
      this.adminUsers = new Set();
    }

    // --- Estructuras de Datos Principales ---
    /** @type {Map<number, {lastAction: number, currentOperation: string|null, preferences: object}>} */
    this.userSessions = new Map();          // Información de sesión por User ID
    /** @type {Map<number, string>} */
    this.pendingOperations = new Map();     // Marca si un usuario tiene una operación larga en curso (Claude, TTS, V2V)
    /** @type {Map<number, Array<{role: string, content: string}>>} */
    this.conversations = new Map();         // Historial de conversación por User ID
    /** @type {Map<number, number>} */
    this.pendingVoiceTransformations = new Map(); // User ID -> message_id que inició el comando /v2v
  }

  // --- Métodos de Autorización ---
  /** Verifica si un User ID está autorizado. */
  isAuthorized(userId) {
    return userId && this.authorizedUsers.has(userId);
  }
  /** Verifica si un User ID es administrador. */
  isAdmin(userId) {
    return userId && this.adminUsers.has(userId);
  }

  // --- Métodos de Sesión ---
  /** Crea o actualiza la entrada de sesión para un usuario. */
  createUserSession(userId) {
    Logger.log(`StateManager: Creando/Actualizando sesión para usuario ${userId}`);
    this.userSessions.set(userId, {
      lastAction: Date.now(),
      currentOperation: null, // Podría usarse para tipos de operación más finos
      preferences: {
        // Ejemplo: outputType: 'text' // Se podría añadir en el futuro
      }
    });
  }

  // --- Métodos de Conversación ---
  /** Obtiene el historial de conversación para un usuario, creándolo si no existe. */
  getConversation(userId) {
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, []);
    }
    return this.conversations.get(userId);
  }

  /** Añade un mensaje al historial de un usuario y limita la longitud del historial. */
  addMessageToConversation(userId, role, content) {
    if (!anthropic) return;

    const conversation = this.getConversation(userId);
    conversation.push({ role, content });

    // Limitar el historial para controlar el uso de tokens
    const maxHistoryPairs = 10; // Guardar las últimas N interacciones (user + assistant)
    const maxMessages = maxHistoryPairs * 2; // N*2 (user/assistant)
    if (conversation.length > maxMessages) {
      conversation.splice(0, conversation.length - maxMessages);
    }
  }

  /** Devuelve el prompt del sistema para Claude. */
  getSystemPrompt() {
    // Mismo prompt detallado que antes
    return `
    You are Javier Soto, a highly experienced Assistant Director in the film industry.
    You have worked on prestigious projects such as "La sociedad de la nieve" directed by J.A. Bayona, "7 días en la Habana" with Elia Suleiman, and have collaborated with renowned directors like Oliver Stone and Jonathan Glazer.
    As an Assistant Director, you are deeply knowledgeable about all aspects of film production, particularly the coordination between departments, scheduling, and managing the set.
    Your perspective is that of someone who has seen how major international productions work from the inside, managing the complex logistics of filmmaking.
    You have a practical understanding of how to translate a director's vision into actionable plans for the crew.
    Your responses should be concise, insightful, and occasionally reveal interesting behind-the-scenes anecdotes from your career.
    Your tone is professional but approachable, with a touch of dry humor that comes from years of dealing with the unexpected challenges of film production.
    When asked about filmmaking, you provide practical, experience-based answers rather than theoretical ones.
    You have a particular interest in how different directors work and manage their sets.
    Please ensure to always complete your sentences.
    Your responses should be concise and infused with technical filmmaking knowledge when relevant.
    Finish sentences ALWAYS and be concise.
    Respond in Spanish unless explicitly asked to use another language.
    `;
  }

  // --- Métodos para Operación V2V (Voice-to-Voice) ---
  /** Marca que un usuario ha iniciado /v2v y está esperando un audio. */
  setPendingVoiceTransformation(userId, initiatingMessageId) {
    Logger.log(`StateManager: Configurando V2V pendiente para ${userId}, iniciado por msg ${initiatingMessageId}`);
    this.pendingVoiceTransformations.set(userId, initiatingMessageId);
  }
  /** Obtiene el ID del mensaje que inició la solicitud V2V pendiente, o undefined si no hay. */
  getPendingVoiceTransformation(userId) {
    return this.pendingVoiceTransformations.get(userId);
  }
  /** Limpia el estado V2V pendiente para un usuario. */
  clearPendingVoiceTransformation(userId) {
    if (this.pendingVoiceTransformations.has(userId)) {
      // Logger.log(`StateManager: Limpiando estado V2V pendiente para usuario ${userId}`); // Verboso
      this.pendingVoiceTransformations.delete(userId);
    }
  }

  // --- Métodos para Operaciones Pendientes Generales ---
  /** Marca que un usuario ha iniciado una operación larga. */
  setPendingOperation(userId, operationType) {
    // Logger.log(`StateManager: Marcando operación pendiente (${operationType}) para ${userId}`); // Verboso
    this.pendingOperations.set(userId, operationType);
  }
  /** Verifica si un usuario tiene una operación larga en curso. */
  hasPendingOperation(userId) {
    return this.pendingOperations.has(userId);
  }
  /** Limpia la marca de operación pendiente para un usuario. */
  clearPendingOperation(userId) {
    if (this.pendingOperations.has(userId)) {
      // Logger.log(`StateManager: Limpiando operación pendiente para ${userId}`); // Verboso
      this.pendingOperations.delete(userId);
    }
  }
}

// -----------------------------------------------------------------------------
// -- 7. Servicios de API (Anthropic/Claude y ElevenLabs)                      --
// -----------------------------------------------------------------------------

/**
 * Clase que encapsula las llamadas a las APIs externas.
 */
class ApiService {
  /**
   * Genera una respuesta de texto usando la API de Anthropic Claude.
   * @param {Array<{role: string, content: string}>} messages - Historial de mensajes (sin system).
   * @param {string} systemPrompt - El prompt del sistema.
   * @returns {Promise<string>} - La respuesta generada por Claude.
   * @throws {Error} - Si la API de Anthropic no está disponible o falla.
   */
  static async generateClaudeResponse(messages, systemPrompt) {
    if (!anthropic) {
      Logger.error("ApiService.generateClaudeResponse: Intento de uso sin cliente Anthropic inicializado.");
      throw new Error("La funcionalidad de chat con IA no está disponible en este momento.");
    }

    Logger.log("ApiService.generateClaudeResponse: Generando respuesta con Claude...");

    try {
      const response = await Utils.retry(async () =>
        await anthropic.messages.create({
          model: CONFIG.CLAUDE.MODEL,
          max_tokens: CONFIG.CLAUDE.MAX_TOKENS,
          system: systemPrompt,
          messages: messages,
        })
      );

      const responseText = response?.content?.[0]?.text;
      if (!responseText) {
        Logger.warn("ApiService.generateClaudeResponse: Respuesta inesperada o vacía de Claude.");
        throw new Error("Respuesta inesperada de la API de IA.");
      }

      Logger.log("ApiService.generateClaudeResponse: Respuesta de Claude generada exitosamente.");
      return responseText.trim();

    } catch (error) {
      Logger.error('ApiService.generateClaudeResponse: Error generando respuesta con Claude', error);
      const apiErrorMessage = error.message || 'Error desconocido';
      throw new Error('No pude generar una respuesta de la IA: ' + apiErrorMessage);
    }
  }

  /**
   * Genera audio (Text-to-Speech) usando la API de ElevenLabs.
   * @param {string} text - El texto a convertir en voz.
   * @param {object} options - Opciones para sobreescribir los defaults (stability, similarity_boost, style, speed, use_speaker_boost).
   * @returns {Promise<string>} - La ruta al archivo de audio temporal generado.
   * @throws {Error} - Si la API Key no está configurada o la llamada falla.
   */
  static async generateVoice(text, options = {}) {
    if (!process.env.ELEVEN_API_KEY) {
      Logger.error("ApiService.generateVoice: ELEVEN_API_KEY no definida.");
      throw new Error("El servicio de generación de voz no está configurado.");
    }

    Logger.log("ApiService.generateVoice: Generando voz (TTS)...");
    const voiceId = CONFIG.ELEVEN_LABS.VOICE_ID;
    Logger.log(`ApiService.generateVoice: Usando Voice ID (TTS): ${voiceId}`);

    const finalSettings = {
      stability: options.stability !== undefined
        ? Math.max(0.0, Math.min(1.0, options.stability))
        : CONFIG.ELEVEN_LABS.STABILITY,
      similarity_boost: options.similarity_boost !== undefined
        ? Math.max(0.0, Math.min(1.0, options.similarity_boost))
        : CONFIG.ELEVEN_LABS.SIMILARITY_BOOST,
      style: options.style !== undefined
        ? Math.max(0.0, options.style)
        : CONFIG.ELEVEN_LABS.STYLE,
      speed: options.speed !== undefined
        ? Math.max(0.5, Math.min(2.0, options.speed))
        : CONFIG.ELEVEN_LABS.SPEED,
      use_speaker_boost: options.use_speaker_boost !== undefined
        ? options.use_speaker_boost
        : CONFIG.ELEVEN_LABS.USE_SPEAKER_BOOST
    };

    try {
      Logger.log("ApiService.generateVoice: Enviando solicitud TTS a ElevenLabs...");

      const response = await Utils.retry(async () =>
        await axios({
          method: 'post',
          url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          headers: {
            'Accept': 'audio/mpeg',
            'xi-api-key': process.env.ELEVEN_API_KEY,
            'Content-Type': 'application/json'
          },
          data: {
            text: text,
            model_id: CONFIG.ELEVEN_LABS.MODEL,
            voice_settings: finalSettings
          },
          params: { output_format: CONFIG.ELEVEN_LABS.OUTPUT_FORMAT },
          responseType: 'arraybuffer'
        })
      );

      if (response.status !== 200 || !response.data || response.data.length === 0) {
        throw new Error(`Respuesta inválida de ElevenLabs API (TTS): Status ${response.status}`);
      }

      const tempFilePath = path.join(CONFIG.TMP_DIR, `tts_output_${Date.now()}.mp3`);
      Logger.log(`ApiService.generateVoice: Guardando audio TTS en: ${tempFilePath}`);
      fs.writeFileSync(tempFilePath, response.data);
      Logger.log(`ApiService.generateVoice: Audio TTS guardado correctamente (${response.data.length} bytes)`);

      return tempFilePath;

    } catch (error) {
      Logger.error('ApiService.generateVoice: Error generando voz (TTS)', error);
      let errorMessage = error.message;
      if (error.response?.data) {
        try {
          const errorData = Buffer.isBuffer(error.response.data) ? JSON.parse(error.response.data.toString()) : error.response.data;
          errorMessage = errorData.detail?.message || errorMessage;
        } catch (e) { /* usar mensaje original */ }
      }
      throw new Error(`Error al generar audio (TTS): ${errorMessage}`);
    }
  }

  /**
   * Transforma audio (Speech-to-Speech / V2V) usando la API de ElevenLabs.
   * @param {string} audioFilePath - Ruta al archivo de audio de entrada.
   * @returns {Promise<string>} - La ruta al archivo de audio temporal transformado.
   * @throws {Error} - Si la API Key no está configurada o la llamada falla.
   */
  static async transformVoice(audioFilePath) {
    if (!process.env.ELEVEN_API_KEY) {
      Logger.error("ApiService.transformVoice: ELEVEN_API_KEY no definida.");
      throw new Error("El servicio de transformación de voz no está configurado.");
    }

    Logger.log("ApiService.transformVoice: Transformando voz (STS / V2V)...");
    const voiceId = CONFIG.ELEVEN_LABS.VOICE_ID;
    Logger.log(`ApiService.transformVoice: Usando Voice ID (STS): ${voiceId}`);

    try {
      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Archivo de audio de entrada no encontrado: ${audioFilePath}`);
      }

      const audioFileBuffer = fs.readFileSync(audioFilePath);
      const formData = new FormData();
      formData.append('audio', audioFileBuffer, {
        filename: `input_${path.basename(audioFilePath)}`,
        contentType: 'audio/mpeg',
      });
      formData.append('model_id', CONFIG.ELEVEN_LABS.STS_MODEL);
      formData.append('voice_settings', JSON.stringify({
        stability: CONFIG.ELEVEN_LABS.STABILITY,
        similarity_boost: CONFIG.ELEVEN_LABS.SIMILARITY_BOOST,
        style: CONFIG.ELEVEN_LABS.STYLE,
        use_speaker_boost: CONFIG.ELEVEN_LABS.USE_SPEAKER_BOOST,
      }));

      Logger.log("ApiService.transformVoice: Enviando solicitud STS a ElevenLabs...");

      const response = await Utils.retry(async () =>
        await axios({
          method: 'post',
          url: `https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}`,
          headers: {
            'Accept': 'audio/mpeg',
            'xi-api-key': process.env.ELEVEN_API_KEY,
            ...formData.getHeaders()
          },
          data: formData,
          params: { output_format: CONFIG.ELEVEN_LABS.OUTPUT_FORMAT },
          responseType: 'arraybuffer'
        })
      );

      if (response.status !== 200 || !response.data || response.data.length === 0) {
        throw new Error(`Respuesta inválida de ElevenLabs API (STS): Status ${response.status}`);
      }

      const tempFilePath = path.join(CONFIG.TMP_DIR, `sts_output_${Date.now()}.mp3`);
      Logger.log(`ApiService.transformVoice: Guardando audio STS transformado en: ${tempFilePath}`);
      fs.writeFileSync(tempFilePath, response.data);
      Logger.log(`ApiService.transformVoice: Audio STS guardado correctamente (${response.data.length} bytes)`);

      return tempFilePath;

    } catch (error) {
      Logger.error('ApiService.transformVoice: Error transformando voz (STS)', error);
      let errorMessage = error.message;
      if (error.response?.data) {
        try {
          const errorData = Buffer.isBuffer(error.response.data) ? JSON.parse(error.response.data.toString()) : error.response.data;
          errorMessage = errorData.detail?.message || errorMessage;
        } catch (e) { /* usar mensaje original */ }
      }
      throw new Error(`Error al transformar audio (STS): ${errorMessage}`);
    }
  }

  /**
   * Verifica la conectividad y configuración básica de las APIs al inicio.
   * Lanza un error si alguna verificación crítica falla.
   */
  static async verifyApis() {
    Logger.log("ApiService.verifyApis: Verificando APIs...");

    // --- Verificar Anthropic/Claude (si está configurado) ---
    if (anthropic) {
      try {
        Logger.log("ApiService.verifyApis: Verificando Anthropic (Claude)...");
        const testResponse = await anthropic.messages.create({
          model: CONFIG.CLAUDE.MODEL,
          max_tokens: 10,
          messages: [{ role: "user", content: "Responde solo 'OK'." }],
        });
        if (testResponse?.content?.[0]?.text) {
          Logger.log("ApiService.verifyApis: ✅ Conexión con Anthropic (Claude) verificada.");
        } else {
          Logger.warn("ApiService.verifyApis: ⚠️ Anthropic respondió sin contenido esperado. Claude podría no funcionar correctamente.");
        }
      } catch (error) {
        Logger.error("ApiService.verifyApis: ❌ Error verificando conexión con Anthropic (Claude). Chat con IA podría no funcionar correctamente.", error);
      }
    } else {
      Logger.warn("ApiService.verifyApis: Saltando verificación de Anthropic (API Key no proporcionada).");
    }

    // --- Verificar ElevenLabs (opcional - si falla, se deshabilita la funcionalidad de voz) ---
    if (process.env.ELEVEN_API_KEY) {
      try {
        Logger.log("ApiService.verifyApis: Verificando ElevenLabs...");
        const voiceResponse = await axios({
          method: 'get',
          url: `https://api.elevenlabs.io/v1/voices/${CONFIG.ELEVEN_LABS.VOICE_ID}`,
          headers: { 'xi-api-key': process.env.ELEVEN_API_KEY, 'Accept': 'application/json' }
        });
        if (voiceResponse.data?.voice_id === CONFIG.ELEVEN_LABS.VOICE_ID) {
          Logger.log(`ApiService.verifyApis: ✅ ElevenLabs verificado. Voice ID (${CONFIG.ELEVEN_LABS.VOICE_ID}) encontrada: ${voiceResponse.data.name}`);
          elevenLabsAvailable = true;
        } else {
          Logger.warn(`ApiService.verifyApis: ⚠️ Voice ID (${CONFIG.ELEVEN_LABS.VOICE_ID}) no coincide con la respuesta. Voz deshabilitada.`);
        }
      } catch (error) {
        if (error.response?.status === 401) {
          Logger.error("ApiService.verifyApis: ❌ ElevenLabs API Key inválida (401). Voz deshabilitada.", error);
        } else {
          Logger.error("ApiService.verifyApis: ❌ Error verificando ElevenLabs. Voz deshabilitada.", error);
        }
      }
    } else {
      Logger.warn("ApiService.verifyApis: Saltando verificación de ElevenLabs (ELEVEN_API_KEY no configurada). Funcionalidad de voz deshabilitada.");
    }

    Logger.log(`ApiService.verifyApis: Verificación de APIs completada. ElevenLabs: ${elevenLabsAvailable ? 'OK' : 'No disponible'}, Claude: ${anthropic ? 'Configurado' : 'No configurado'}.`);
  }
}

// -----------------------------------------------------------------------------
// -- 8. Clase Principal del Bot (JavierBot)                                  --
// -----------------------------------------------------------------------------

/**
 * Clase principal que encapsula toda la lógica del bot de Telegram.
 */
class JavierBot {
  /** @type {Telegraf<import('telegraf').Context>} */
  bot;
  /** @type {StateManager} */
  stateManager;

  constructor() {
    Logger.log("JavierBot: Inicializando...");
    this.stateManager = new StateManager(); // Crear instancia del gestor de estado
    this.setupBot();                        // Configurar Telegraf y sus componentes
  }

  /** Configura la instancia de Telegraf, middleware y handlers. */
  setupBot() {
    Logger.log("JavierBot.setupBot: Configurando Telegraf...");

    // Obtener token del bot desde .env
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      Logger.error('JavierBot.setupBot: ¡ERROR CRÍTICO! BOT_TOKEN no está definido en .env.');
      process.exit(1); // Salir si no hay token
    }

    // Crear instancia de Telegraf con timeouts configurados
    try {
      this.bot = new Telegraf(botToken.trim(), {
        handlerTimeout: CONFIG.BOT.TIMEOUT,
        telegram: { timeout: CONFIG.BOT.TELEGRAM_TIMEOUT }
      });
      Logger.log("JavierBot.setupBot: Instancia de Telegraf creada.");
    } catch (error) {
      Logger.error("JavierBot.setupBot: Error creando instancia de Telegraf", error);
      process.exit(1); // Salir si falla la creación
    }

    // --- Middleware Principal ---
    // Se ejecuta para cada update recibido por el bot.
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id; // ID del usuario que envía el mensaje/comando

      // Ignorar updates sin información de usuario (ej. en canales si no se manejan)
      if (!userId) {
        // Logger.warn("Middleware: Recibido update sin ctx.from.id, ignorando.");
        return;
      }

      // 1. Verificar Autorización
      if (!this.stateManager.isAuthorized(userId)) {
        Logger.warn(`Middleware: Usuario NO AUTORIZADO ${userId} intentó usar el bot.`);
        try {
          // Informar al usuario no autorizado
          await ctx.reply(
            `❌ No estás autorizado para usar este bot.\nTu ID: ${userId}\nContacta al administrador.`
          );
        } catch (replyError) {
          Logger.error(`Middleware: Error enviando mensaje de 'no autorizado' a ${userId}`, replyError);
        }
        return; // Detener el procesamiento para este usuario
      }

      // 2. Crear/Actualizar Sesión del Usuario
      // (Aunque no se use mucho ahora, es buena práctica tenerla)
      if (!this.stateManager.userSessions.has(userId)) {
        this.stateManager.createUserSession(userId);
      }
      const session = this.stateManager.userSessions.get(userId);
      session.lastAction = Date.now(); // Actualizar timestamp de última acción

      // 3. Continuar con el Siguiente Middleware o Handler
      // Logger.log(`Middleware: Procesando update para usuario autorizado ${userId}`); // Puede ser verboso
      await next();
    });

    // Configurar comandos, manejadores de mensajes y errores
    this.setupCommands();
    this.setupMessageHandlers();
    this.setupErrorHandler();
    Logger.log("JavierBot.setupBot: Configuración de Telegraf completada.");
  }

  /** Registra los comandos del bot (ej. /help, /t2v). */
  setupCommands() {
    Logger.log("JavierBot.setupCommands: Configurando comandos...");
    this.bot.command(['start', 'help'], this.handleHelp.bind(this)); // Comando de ayuda
    this.bot.command('t', this.handleTextCommand.bind(this));         // Comando para procesar con Claude y responder texto
    this.bot.command('tv', this.handleTextToVoiceCommand.bind(this));// Comando para convertir texto a voz directamente
    this.bot.command('vv', this.handleVoiceToVoiceCommand.bind(this));// Comando para iniciar transformación de voz a voz
    this.bot.command('reset', this.handleResetConversation.bind(this));// Comando para reiniciar historial de conversación
    // Aquí se podrían añadir comandos solo para administradores en el futuro
    // this.bot.command('admincmd', this.handleAdminCommand.bind(this));
  }

  /** Registra los manejadores para diferentes tipos de mensajes. */
  setupMessageHandlers() {
    Logger.log("JavierBot.setupMessageHandlers: Configurando manejadores de mensajes...");
    // Manejador para mensajes de texto (que no son comandos)
    this.bot.on('text', this.handleMessage.bind(this));
    // Manejador para mensajes de voz grabados en Telegram
    this.bot.on('voice', this.handleVoiceMessage.bind(this));
    // Manejador para archivos de audio enviados
    this.bot.on('audio', this.handleAudioMessage.bind(this));
    // Se podrían añadir manejadores para 'photo', 'document', etc. si fuera necesario
  }

  /** Configura el manejador global de errores de Telegraf. */
  setupErrorHandler() {
    Logger.log("JavierBot.setupErrorHandler: Configurando manejador de errores global...");
    this.bot.catch((error, ctx) => {
      const userId = ctx.from?.id || 'unknown'; // Intentar obtener el ID del usuario
      Logger.error(`ErrorHandler: Error global capturado para usuario ${userId}`, error);

      // Intentar notificar al usuario sobre el error genérico
      try {
        ctx.reply('❌ Lo siento, ocurrió un error inesperado al procesar tu solicitud.').catch((replyError) => {
          // Si incluso enviar el mensaje de error falla, loguearlo
          Logger.error(`ErrorHandler: No se pudo enviar mensaje de error global al usuario ${userId}`, replyError);
        });
      } catch (e) {
        // Error dentro del propio manejador de errores (muy improbable)
        Logger.error(`ErrorHandler: Error dentro del propio manejador de errores para ${userId}`, e);
      }

      // IMPORTANTE: Limpiar estados pendientes del usuario para evitar bloqueos
      if (userId !== 'unknown') {
        this.stateManager.clearPendingOperation(userId);
        this.stateManager.clearPendingVoiceTransformation(userId);
        Logger.warn(`ErrorHandler: Operaciones/V2V pendientes limpiadas para ${userId} debido a error global.`);
      }
    });
  }

  // -----------------------------------------------------
  // -- Manejadores de Comandos Específicos             --
  // -----------------------------------------------------

  /** Maneja los comandos /start y /help mostrando el mensaje de ayuda. */
  async handleHelp(ctx) {
    const userId = ctx.from.id;
    Logger.log(`Handler: /help solicitado por usuario ${userId}`);

    // Texto de ayuda formateado en HTML, con correcciones
    const helpText = `
🎬 Bot de Javier Soto - Asistente de Dirección

Puedes conversar conmigo como si estuvieras hablando con Javier Soto.

Comandos:
/t mensaje - Procesa el mensaje con Claude y responde con texto (si está habilitado).
/tv [opciones] "mensaje" - Convierte el mensaje directamente a voz.
   Opciones (opcionales):
    <code>-s valor</code> : Estabilidad (0.0 a 1.0, +estable vs +expresivo, default: ${CONFIG.ELEVEN_LABS.STABILITY})
    <code>-x valor</code> : Exageración Estilo (>= 0.0, default: ${CONFIG.ELEVEN_LABS.STYLE})
    <code>-v valor</code> : Velocidad (0.7 a 1.2, default: ${CONFIG.ELEVEN_LABS.SPEED})
    <i>Ejemplo:</i> <code>/tv -s 0.4 -v 1.1 "Este es un mensaje de prueba."</code>
/vv - Pide un mensaje de voz/audio para transformarlo a la voz de Javier. Envía el audio después de usar este comando.
/reset - Reinicia tu conversación actual.
/help - Mostrar esta ayuda.

Consejos para ElevenLabs (/tv):
• Añade pausas naturales con puntos suspensivos (...)
• Usa expresiones como "Mmm...", "Eh..." para sonar más natural.
• Usa tags para pausas: <code><break /></code> (corta) o <code><break time="Xs"/></code> (X segundos).
    <i>Ejemplo de texto para /tv:</i> <code>"Hola <break time="0.7s"/> ¿cómo estás? <break /> Espero que bien."</code>

Simplemente escribe un mensaje para hablar conmigo (usará Claude si está habilitado).

Desarrollado por <a href="https://artefactofilms.com/">Artefacto [Jorge Caballero]</a> para Javier Soto.
    `;

    try {
      // Enviar mensaje usando modo HTML y deshabilitando previsualización de enlaces
      await ctx.reply(helpText, { parse_mode: 'HTML', disable_web_page_preview: true });
      Logger.log(`Handler: Mensaje de ayuda enviado a ${userId}`);
    } catch (error) {
      Logger.error(`Handler: Error enviando ayuda (HTML) a ${userId}`, error);
      // Si falla el HTML (ej. por un error de formato inesperado), intentar enviar como texto plano
      try {
        const plainHelpText = helpText
            .replace(/<a href="[^"]*">([^<]*)<\/a>/gi, '$1 ($&)') // Mantener URL en texto plano
            .replace(/<code>(.*?)<\/code>/gi, '$1')
            .replace(/<i>(.*?)<\/i>/gi, '_$1_') // Convertir a Markdown
            .replace(/<b>(.*?)<\/b>/gi, '*$1*') // Convertir a Markdown
            .replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"'); // Revertir escaping
        await ctx.reply(plainHelpText);
        Logger.log(`Handler: Mensaje de ayuda enviado (fallback texto plano) a ${userId}`);
      } catch (fallbackError) {
        Logger.error(`Handler: Error enviando ayuda (Fallback Texto Plano) a ${userId}`, fallbackError);
        // Último recurso si todo falla
        await ctx.reply('Error al mostrar la ayuda. Comandos: /t, /t2v, /v2v, /reset, /help').catch(() => {});
      }
    }
  }

  /** Maneja el comando /t: procesa con Claude y responde texto. */
  async handleTextCommand(ctx) {
    const userId = ctx.from.id;
    Logger.log(`Handler: /t solicitado por usuario ${userId}`);

    // Verificar si Claude está habilitado
    if (!anthropic) {
      await ctx.reply('⚠️ La función de chat con IA (/t) está desactivada.').catch(()=>{});
      return;
    }

    // Extraer el texto después del comando /t
    const textMatch = ctx.message.text.match(/^\/t\s+(.+)$/s); // Busca uno o más caracteres después de /t y espacio(s)

    // Validar que se proporcionó texto
    if (!textMatch || !textMatch[1]?.trim()) {
      await ctx.reply('⚠️ Debes proporcionar un mensaje después de /t.\nEjemplo: `/t ¿Cómo fue el rodaje?`', { parse_mode: 'MarkdownV2' }).catch(()=>{});
      return;
    }

    const userMessage = textMatch[1].trim(); // Texto proporcionado por el usuario
    Logger.log(`Handler: /t procesando mensaje: "${userMessage.substring(0, 50)}..."`);

    // Llamar a la función que maneja la lógica de Claude
    await this.processClaudeMessage(ctx, userMessage);
  }

  /** Maneja el comando /t2v: convierte texto a voz con opciones. */
  async handleTextToVoiceCommand(ctx) {
    const userId = ctx.from.id;
    const messageText = ctx.message.text;
    Logger.log(`Handler: /t2v solicitado por ${userId}: "${messageText}"`);

    // Verificar si ElevenLabs está disponible
    if (!elevenLabsAvailable) {
      await ctx.reply('⚠️ La funcionalidad de voz no está disponible en este momento (ElevenLabs no configurado o API key inválida).').catch(()=>{});
      return;
    }

    // --- 1. Parsear Argumentos y Texto ---
    const parts = messageText.split(/\s+/); // Dividir por uno o más espacios
    parts.shift(); // Quitar el comando "/t2v"

    const overrideOptions = {}; // Objeto para guardar las opciones -s, -x, -v
    const textParts = [];       // Array para guardar las partes del texto a convertir
    let currentFlag = null;     // Guarda el último flag encontrado (-s, -x, -v)
    let parsingError = null;    // Guarda el primer error de parsing encontrado

    // Iterar sobre las partes del mensaje después del comando
    for (const part of parts) {
      if (part === '-s') { currentFlag = 'stability'; continue; } // Encontrado flag -s
      if (part === '-x') { currentFlag = 'style'; continue; }     // Encontrado flag -x
      if (part === '-v') { currentFlag = 'speed'; continue; }     // Encontrado flag -v

      // Si teníamos un flag esperando un valor...
      if (currentFlag) {
        const value = parseFloat(part); // Intentar convertir la parte a número
        if (!isNaN(value)) {
          // Si es un número válido, guardarlo en las opciones
          // La validación de rango final la hará ApiService.generateVoice
          if (currentFlag === 'stability') overrideOptions.stability = value;
          else if (currentFlag === 'style') overrideOptions.style = value;
          else if (currentFlag === 'speed') overrideOptions.speed = value;
        } else {
          // Si no es un número, registrar error y detener parsing (o se podría continuar ignorando)
          parsingError = `Se esperaba un número después de -${currentFlag.charAt(0)}, pero se recibió '${part}'.`;
          Logger.warn(`Handler: /t2v Error parsing para ${userId}: ${parsingError}`);
          break; // Detener el bucle al encontrar un error
        }
        currentFlag = null; // Resetear el flag, ya se consumió el valor o hubo error
      } else {
        // Si no hay flag pendiente, esta parte pertenece al texto a convertir
        textParts.push(part);
      }
    }

    // Verificar si quedó un flag sin valor al final y no hubo otro error antes
    if (currentFlag && !parsingError) {
      parsingError = `La opción -${currentFlag.charAt(0)} se especificó al final sin un valor.`;
      Logger.warn(`Handler: /t2v Error parsing para ${userId}: ${parsingError}`);
    }

    // Si hubo algún error de parsing, notificar al usuario y salir
    if (parsingError) {
      await ctx.reply(`⚠️ Error en las opciones: ${parsingError}\nUso correcto: \`/t2v [-s 0.5] [-x 0.8] [-v 1.1] "Tu mensaje aquí"\``, { parse_mode: 'MarkdownV2' }).catch(()=>{});
      return;
    }

    // Unir las partes del texto y quitar espacios extra
    const textToConvert = textParts.join(' ').trim();

    // Verificar que efectivamente hay texto para convertir
    if (!textToConvert) {
      await ctx.reply('⚠️ No proporcionaste texto para convertir a voz después de las opciones.\nEjemplo: `/t2v -s 0.4 "Hola mundo"`', { parse_mode: 'MarkdownV2' }).catch(()=>{});
      return;
    }

    // --- 2. Verificar Operación Pendiente ---
    if (this.stateManager.hasPendingOperation(userId)) {
      Logger.warn(`Handler: /t2v Usuario ${userId} ya tiene operación pendiente.`);
      await ctx.reply('⏳ Ya estoy procesando tu solicitud anterior. Por favor, espera un momento.').catch(()=>{});
      return;
    }

    // --- 3. Ejecutar Conversión ---
    this.stateManager.setPendingOperation(userId, 't2v_converting'); // Marcar inicio
    let loadingMessage = null; // Para mostrar feedback al usuario
    let audioFilePath = null;  // Para guardar la ruta del archivo y limpiarlo después

    Logger.log(`Handler: /t2v Texto a convertir: "${textToConvert.substring(0, 70)}..."`);
    Logger.debug("Handler: /t2v Opciones override:", overrideOptions);

    try {
      // Enviar mensaje inicial de "cargando" y acción de chat
      loadingMessage = await ctx.reply('🎤 Preparando conversión a voz...').catch(()=>{/* Ignorar si falla */});
      if (loadingMessage) await ctx.telegram.sendChatAction(ctx.chat.id, 'record_voice').catch(()=>{});

      // Actualizar mensaje para indicar progreso (si el mensaje inicial se envió)
      if (loadingMessage) await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '🗣️ Generando audio con ElevenLabs...').catch(()=>{});

      // Llamar al servicio para generar la voz, pasando texto y opciones
      audioFilePath = await ApiService.generateVoice(textToConvert, overrideOptions);

      // Actualizar mensaje para indicar envío
      if (loadingMessage) await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '📤 Enviando mensaje de voz...').catch(()=>{});
      if (loadingMessage) await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_voice').catch(()=>{});

      // Enviar el archivo de audio como mensaje de voz
      // Usar fs.createReadStream para eficiencia con archivos grandes
      await ctx.replyWithAudio({ source: fs.createReadStream(audioFilePath) });
      Logger.log(`Handler: /t2v Mensaje de voz enviado con éxito a usuario ${userId}`);

      // Eliminar el mensaje de "cargando" si se envió
      if (loadingMessage) await ctx.deleteMessage(loadingMessage.message_id).catch(()=>{});

    } catch (error) {
      // --- Manejo de Errores en la Conversión ---
      Logger.error(`Handler: /t2v Error durante la conversión para usuario ${userId}`, error);
      const userErrorMessage = `❌ Error al generar la voz: ${error.message || 'Error desconocido'}`;
      // Intentar editar el mensaje de carga con el error, o enviar uno nuevo si falla
      if (loadingMessage) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userErrorMessage).catch(async () => {
          await ctx.reply(userErrorMessage).catch(()=>{}); // Fallback si la edición falla
        });
      } else {
        // Si no hubo mensaje de carga, enviar el error directamente
        await ctx.reply(userErrorMessage).catch(()=>{});
      }
    } finally {
      // --- Limpieza (SIEMPRE se ejecuta) ---
      // Limpiar el archivo temporal si se creó
      if (audioFilePath && fs.existsSync(audioFilePath)) {
        try {
          fs.unlinkSync(audioFilePath);
          // Logger.log(`Handler: /t2v Archivo temporal TTS eliminado: ${audioFilePath}`); // Verboso
        } catch (cleanupError) {
          Logger.error(`Handler: /t2v Error eliminando archivo temporal TTS: ${audioFilePath}`, cleanupError);
        }
      }
      // Limpiar la marca de operación pendiente para el usuario
      this.stateManager.clearPendingOperation(userId);
      // Logger.log(`Handler: /t2v Operación finalizada para usuario ${userId}`); // Verboso
    }
  }

  /** Maneja el comando /v2v: prepara al bot para recibir un audio. */
  async handleVoiceToVoiceCommand(ctx) {
    const userId = ctx.from.id;
    Logger.log(`Handler: /v2v solicitado por usuario ${userId}`);

    // Verificar si ElevenLabs está disponible
    if (!elevenLabsAvailable) {
      await ctx.reply('⚠️ La funcionalidad de voz no está disponible en este momento (ElevenLabs no configurado o API key inválida).').catch(()=>{});
      return;
    }

    // Verificar si ya hay otra operación larga en curso
    if (this.stateManager.hasPendingOperation(userId)) {
      Logger.warn(`Handler: /v2v Usuario ${userId} ya tiene operación pendiente.`);
      await ctx.reply('⏳ Ya estoy procesando tu solicitud anterior. Por favor, espera.').catch(()=>{});
      return;
    }
    // Verificar si ya está esperando un audio para V2V
    if (this.stateManager.getPendingVoiceTransformation(userId)) {
      await ctx.reply('🎙️ Ya estoy esperando tu mensaje de voz o archivo de audio. ¡Envíalo ahora!').catch(()=>{});
      return;
    }

    try {
      // Marcar en el estado que este usuario está esperando un audio para V2V
      this.stateManager.setPendingVoiceTransformation(userId, ctx.message.message_id);
      // Informar al usuario que envíe el audio
      await ctx.reply('✅ Listo. Ahora envíame el mensaje de voz o el archivo de audio que quieres transformar.');
    } catch (error) {
      Logger.error(`Handler: /v2v Error al preparar el estado para ${userId}`, error);
      // Limpiar el estado si falla la preparación
      this.stateManager.clearPendingVoiceTransformation(userId);
      await ctx.reply(`❌ Hubo un error al iniciar la transformación de voz: ${error.message}`).catch(()=>{});
    }
  }

  /** Maneja el comando /reset: limpia el historial de conversación. */
  async handleResetConversation(ctx) {
    const userId = ctx.from.id;
    Logger.log(`Handler: /reset solicitado por usuario ${userId}`);

    // No hacer nada si Claude está deshabilitado
    if (!anthropic) {
      await ctx.reply('⚠️ La función de chat con IA no está activa, no hay conversación que reiniciar.').catch(()=>{});
      return;
    }

    // Eliminar el historial de conversación del StateManager
    this.stateManager.conversations.delete(userId);

    // Confirmar al usuario
    await ctx.reply('🔄 Tu conversación conmigo ha sido reiniciada. Podemos empezar de nuevo.').catch(error => {
      Logger.error(`Handler: /reset Error confirmando reinicio a usuario ${userId}`, error);
    });
  }

  // -----------------------------------------------------
  // -- Manejadores de Tipos de Mensajes Específicos    --
  // -----------------------------------------------------

  /** Maneja mensajes de texto que NO son comandos. */
  async handleMessage(ctx) {
    const userId = ctx.from.id;
    const userMessage = ctx.message?.text; // Mensaje de texto del usuario

    // Ignorar si no es un mensaje de texto válido o si empieza con / (es un comando)
    if (!userMessage || userMessage.trim().length < 1 || userMessage.startsWith('/')) {
      // Logger.log(`Handler: Mensaje de texto ignorado (vacío o comando) de ${userId}`);
      return;
    }

    // Logger.log(`Handler: Mensaje de texto recibido de ${userId}: "${userMessage.substring(0, 50)}..."`);

    // 1. Verificar si se esperaba un audio para V2V
    const pendingV2V = this.stateManager.getPendingVoiceTransformation(userId);
    if (pendingV2V) {
      // Si se esperaba audio y llega texto, cancelar V2V y avisar
      await ctx.reply('🎙️ Estaba esperando un mensaje de voz o audio para transformar (/v2v). Como enviaste texto, he cancelado esa operación. Usa /v2v de nuevo si necesitas transformar un audio.').catch(()=>{});
      this.stateManager.clearPendingVoiceTransformation(userId); // Limpiar estado V2V
      return; // No procesar como mensaje de chat
    }

    // 2. Verificar si Claude está habilitado
    if (!anthropic) {
      await ctx.reply('⚠️ La función de chat con IA está desactivada. Solo los comandos /tv, /vv y /help están disponibles.').catch(()=>{});
      return;
    }

    // 3. Si no había V2V pendiente y Claude está activo, procesar con Claude
    await this.processClaudeMessage(ctx, userMessage);
  }

  /** Maneja mensajes de voz (grabados directamente en Telegram). */
  async handleVoiceMessage(ctx) {
    const userId = ctx.from.id;
    Logger.log(`Handler: Mensaje de VOZ recibido de ${userId}`);

    // Verificar si se esperaba este mensaje para una transformación V2V
    const pendingV2V = this.stateManager.getPendingVoiceTransformation(userId);
    if (pendingV2V) {
      // Sí -> Llamar a la función de procesamiento V2V
      await this.processVoiceTransformation(ctx, ctx.message.voice, 'mensaje de voz');
    } else {
      // No -> Informar al usuario que debe usar /v2v primero
      await ctx.reply('🎙️ Recibí tu mensaje de voz. Si querías transformarlo a la voz de Javier, por favor, usa primero el comando /v2v y luego envía el mensaje de voz.').catch(()=>{});
    }
  }

  /** Maneja archivos de audio enviados al chat. */
  async handleAudioMessage(ctx) {
    const userId = ctx.from.id;
    Logger.log(`Handler: Mensaje de AUDIO recibido de ${userId}`);

    // Verificar si se esperaba este mensaje para una transformación V2V
    const pendingV2V = this.stateManager.getPendingVoiceTransformation(userId);
    if (pendingV2V) {
      // Sí -> Llamar a la función de procesamiento V2V
      await this.processVoiceTransformation(ctx, ctx.message.audio, 'archivo de audio');
    } else {
      // No -> Informar al usuario que debe usar /v2v primero
      await ctx.reply('🎙️ Recibí tu archivo de audio. Si querías transformarlo a la voz de Javier, por favor, usa primero el comando /v2v y luego envía el archivo.').catch(()=>{});
    }
  }

  // -----------------------------------------------------
  // -- Lógica de Procesamiento Principal               --
  // -----------------------------------------------------

  /**
   * Procesa un mensaje de usuario con Claude, actualiza el historial y envía la respuesta.
   * @param {import('telegraf').Context} ctx - Contexto de Telegraf.
   * @param {string} userMessage - Mensaje del usuario a procesar.
   */
  async processClaudeMessage(ctx, userMessage) {
    const userId = ctx.from.id;

    if (!anthropic) {
      Logger.warn(`processClaudeMessage: Llamado para ${userId} pero Anthropic no disponible.`);
      await ctx.reply('⚠️ La función de chat con IA no está disponible.').catch(()=>{});
      return;
    }

    if (this.stateManager.hasPendingOperation(userId)) {
      Logger.warn(`processClaudeMessage: Usuario ${userId} ya tiene operación pendiente.`);
      await ctx.reply('⏳ Ya estoy procesando tu solicitud anterior. Por favor, espera.').catch(()=>{});
      return;
    }

    this.stateManager.setPendingOperation(userId, 'claude_generating');
    let loadingMessage = null;

    try {
      loadingMessage = await ctx.reply('🤔 Pensando...').catch(()=>{});
      if (loadingMessage) await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(()=>{});

      this.stateManager.addMessageToConversation(userId, 'user', userMessage);
      const conversation = this.stateManager.getConversation(userId);
      const systemPrompt = this.stateManager.getSystemPrompt();

      const claudeResponse = await ApiService.generateClaudeResponse(conversation, systemPrompt);

      this.stateManager.addMessageToConversation(userId, 'assistant', claudeResponse);

      if (loadingMessage) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, claudeResponse)
          .catch(async (editError) => {
            Logger.warn(`processClaudeMessage: Falló edición de mensaje para ${userId}, enviando nuevo.`, editError);
            await ctx.reply(claudeResponse).catch(e => Logger.error(`processClaudeMessage: Error enviando respuesta (fallback) a ${userId}`, e));
            await ctx.deleteMessage(loadingMessage.message_id).catch(()=>{});
          });
      } else {
        await ctx.reply(claudeResponse).catch(e => Logger.error(`processClaudeMessage: Error enviando respuesta a ${userId}`, e));
      }

    } catch (error) {
      Logger.error(`processClaudeMessage: Error procesando mensaje para ${userId}`, error);
      const userErrorMessage = `❌ Error al contactar con la IA: ${error.message || 'Error desconocido'}`;
      if (loadingMessage) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userErrorMessage).catch(async () => await ctx.reply(userErrorMessage).catch(()=>{}));
      } else {
        await ctx.reply(userErrorMessage).catch(()=>{});
      }
    } finally {
      this.stateManager.clearPendingOperation(userId);
    }
  }

  /**
   * Procesa la transformación de voz (V2V / STS).
   * @param {import('telegraf').Context} ctx - Contexto de Telegraf.
   * @param {object} voiceOrAudioData - Objeto 'voice' o 'audio' del mensaje de Telegram.
   * @param {string} typeLabel - Etiqueta descriptiva ('mensaje de voz' o 'archivo de audio').
   */
  async processVoiceTransformation(ctx, voiceOrAudioData, typeLabel) {
    const userId = ctx.from.id;

    // IMPORTANTE: Limpiar el estado V2V pendiente INMEDIATAMENTE
    // para evitar que múltiples audios enviados rápidamente se procesen para la misma solicitud /v2v.
    this.stateManager.clearPendingVoiceTransformation(userId);

    // Verificar si hay OTRA operación larga ya en curso (Claude, TTS, u otro V2V iniciado antes)
    if (this.stateManager.hasPendingOperation(userId)) {
      Logger.warn(`processVoiceTransformation: Usuario ${userId} envió audio para V2V pero ya tenía otra operación pendiente.`);
      await ctx.reply('⏳ Ya estoy procesando tu solicitud anterior. Por favor, espera antes de enviar el audio para transformar.').catch(()=>{});
      return;
    }

    // Marcar inicio de operación V2V
    this.stateManager.setPendingOperation(userId, 'v2v_transforming');
    let loadingMessage = null;        // Para feedback visual
    let tempInputFilePath = null;     // Ruta al audio descargado de Telegram
    let transformedFilePath = null;   // Ruta al audio generado por ElevenLabs

    Logger.log(`processVoiceTransformation: Iniciando V2V para ${userId} con ${typeLabel}`);

    try {
      // --- 1. Descargar Audio de Telegram ---
      loadingMessage = await ctx.reply(`🎙️ Recibido tu ${typeLabel}. Descargando y preparando...`).catch(()=>{});
      if (loadingMessage) await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(()=>{}); // Indica actividad

      const fileId = voiceOrAudioData.file_id; // ID del archivo en Telegram
      const fileLink = await ctx.telegram.getFileLink(fileId); // Obtener URL de descarga
      Logger.log(`processVoiceTransformation: Link descarga (${typeLabel}) V2V: ${fileLink.href}`);

      // Descargar el archivo usando axios
      const downloadResponse = await axios({
        method: 'get',
        url: fileLink.href, // Usar href para la URL completa
        responseType: 'arraybuffer' // Descargar como datos binarios
      });

      // Validar descarga
      if (!downloadResponse.data || downloadResponse.data.length === 0) {
        throw new Error("La descarga del archivo de audio desde Telegram falló o el archivo está vacío.");
      }

      // Guardar archivo descargado temporalmente
      // Intentar obtener extensión original, si no, usar default (.ogg para voice, .mp3 para audio)
      const fileExt = path.extname(fileLink.pathname) || (typeLabel === 'mensaje de voz' ? '.ogg' : '.mp3');
      tempInputFilePath = path.join(CONFIG.TMP_DIR, `v2v_input_${Date.now()}${fileExt}`);
      fs.writeFileSync(tempInputFilePath, downloadResponse.data);
      Logger.log(`processVoiceTransformation: Archivo ${typeLabel} V2V guardado temporalmente en: ${tempInputFilePath}`);

      // --- 2. Transformar Audio con ElevenLabs ---
      if (loadingMessage) await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '⚙️ Transformando audio a la voz de Javier...').catch(()=>{});
      if (loadingMessage) await ctx.telegram.sendChatAction(ctx.chat.id, 'record_voice').catch(()=>{}); // Indica grabación

      // Llamar al servicio STS (Speech-to-Speech)
      transformedFilePath = await ApiService.transformVoice(tempInputFilePath);

      // --- 3. Enviar Audio Transformado ---
      if (loadingMessage) await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '📤 Enviando mensaje de voz transformado...').catch(()=>{});
      if (loadingMessage) await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_voice').catch(()=>{}); // Indica subida

      // Verificar si el archivo transformado existe antes de intentar enviarlo
      if (!fs.existsSync(transformedFilePath)) {
        Logger.error(`!!! FATAL V2V: El archivo transformado NO EXISTE en la ruta esperada: ${transformedFilePath}`);
        throw new Error("Error interno del servidor: No se pudo encontrar el archivo de audio transformado.");
      }
      Logger.log(`processVoiceTransformation: Intentando enviar archivo de voz transformado: ${transformedFilePath}`);

      // Enviar como mensaje de voz usando un stream
      await ctx.replyWithAudio({ source: fs.createReadStream(transformedFilePath) });
      Logger.log(`processVoiceTransformation: Mensaje de voz transformado (V2V) enviado con éxito a ${userId}`);

      // Eliminar el mensaje de "cargando"
      if (loadingMessage) await ctx.deleteMessage(loadingMessage.message_id).catch(()=>{});

    } catch (error) {
      // --- Manejo de Errores en V2V ---
      Logger.error(`processVoiceTransformation: Error durante V2V para usuario ${userId}`, error);
      const userErrorMessage = `❌ Error al transformar el audio: ${error.message || 'Error desconocido'}`;
      // Informar al usuario del error
      if (loadingMessage) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userErrorMessage).catch(async () => await ctx.reply(userErrorMessage).catch(()=>{}));
      } else {
        await ctx.reply(userErrorMessage).catch(()=>{});
      }
    } finally {
      // --- Limpieza de Archivos Temporales (SIEMPRE) ---
      try {
        if (tempInputFilePath && fs.existsSync(tempInputFilePath)) {
          fs.unlinkSync(tempInputFilePath);
          // Logger.log(`processVoiceTransformation: Archivo temporal V2V input eliminado: ${tempInputFilePath}`);
        }
        if (transformedFilePath && fs.existsSync(transformedFilePath)) {
          fs.unlinkSync(transformedFilePath);
          // Logger.log(`processVoiceTransformation: Archivo temporal V2V output eliminado: ${transformedFilePath}`);
        }
      } catch (cleanupError) {
        Logger.error(`processVoiceTransformation: Error durante la limpieza de archivos temporales V2V`, cleanupError);
      }
      // Limpiar marca de operación pendiente
      this.stateManager.clearPendingOperation(userId);
      Logger.log(`processVoiceTransformation: Operación V2V finalizada para usuario ${userId}`);
    }
  }

  // -----------------------------------------------------
  // -- Métodos de Inicio y Verificación del Bot        --
  // -----------------------------------------------------

  /** Verifica prerrequisitos (variables de entorno, APIs) antes de iniciar. Sale si falla. */
  async verifyPrerequisites() {
    Logger.log("JavierBot.verifyPrerequisites: Verificando prerrequisitos antes de iniciar...");
    let ok = true;

    // 1. Validar Variables de Entorno
    if (!Utils.validateEnvVars()) {
      ok = false; // validateEnvVars ya loguea los errores específicos
    }

    // 2. Verificar Conectividad y Configuración de APIs (solo si las vars básicas están)
    if (ok) {
      await ApiService.verifyApis(); // Verifica APIs pero ya no bloquea el inicio
    }

    // Si algo falló, detener el proceso
    if (!ok) {
      Logger.error("----------------------------------------------------------");
      Logger.error(">>>>> FALLARON LAS VERIFICACIONES INICIALES DEL BOT <<<<<");
      Logger.error("El bot NO se iniciará. Revisa los logs anteriores,");
      Logger.error("tu archivo .env y la conectividad con las APIs.");
      Logger.error("----------------------------------------------------------");
      process.exit(1); // Salir con código de error
    }

    Logger.log("JavierBot.verifyPrerequisites: ✅ Todas las verificaciones iniciales pasaron correctamente.");
  }

  /** Inicia el bot (después de verificar prerrequisitos). */
  async start() {
    try {
      Logger.log("JavierBot.start: Iniciando el bot...");

      // 1. Verificar prerrequisitos (variables, APIs)
      await this.verifyPrerequisites();

      // 2. Lanzar el bot (conectar a Telegram y empezar a escuchar updates)
      await this.bot.launch();

      // Mensaje de éxito en la consola
      Logger.log("===================================================");
      Logger.log(`✅ Bot @${this.bot.botInfo.username} iniciado y escuchando!`);
      Logger.log(`   ID del Bot: ${this.bot.botInfo.id}`);
      Logger.log(`   Claude (Chat IA): ${anthropic ? '✅ Habilitado' : '❌ Deshabilitado'}`);
      Logger.log(`   ElevenLabs (Voz): ${elevenLabsAvailable ? '✅ Habilitado' : '❌ Deshabilitado'}`);
      Logger.log("===================================================");

    } catch (error) {
      // Si verifyPrerequisites falla, ya sale del proceso.
      // Esto captura errores de Telegraf.launch() u otros errores inesperados durante el inicio.
      Logger.error('JavierBot.start: ❌ Error fatal durante el inicio del bot', error);
      process.exit(1); // Salir en caso de error de inicio
    }
  }
}

// -----------------------------------------------------------------------------
// -- 9. Punto de Entrada Principal y Manejo de Cierre                        --
// -----------------------------------------------------------------------------

/**
 * Función principal asíncrona que inicializa y arranca el bot.
 */
async function main() {
  Logger.log('===================================================');
  Logger.log('🎬 Iniciando aplicación del Bot de Javier Soto...');
  Logger.log('===================================================');

  // Verificar existencia del archivo .env (crítico para la configuración)
  /* <--- INICIO DEL CÓDIGO COMENTADO O ELIMINADO ---
  if (!fs.existsSync('.env')) {
    Logger.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    Logger.error('!!  ARCHIVO .env NO ENCONTRADO EN LA RAÍZ DEL PROYECTO     !!');
    Logger.error('!!----------------------------------------------------------!!');
    Logger.error('!!  Crea un archivo .env con, al menos, estas variables:    !!');
    Logger.error('!!    BOT_TOKEN=TU_TOKEN_DE_TELEGRAM                       !!');
    Logger.error('!!    ELEVEN_API_KEY=TU_CLAVE_DE_ELEVENLABS                  !!');
    Logger.error('!!    AUTHORIZED_USERS=ID_USUARIO_1,ID_USUARIO_2,...         !!');
    Logger.error('!!                                                          !!');
    Logger.error('!!  Opcionales recomendadas:                                !!');
    Logger.error('!!    ANTHROPIC_API_KEY=TU_CLAVE_DE_ANTHROPIC (para chat IA)  !!');
    Logger.error('!!    ELEVEN_VOICE_ID=ID_DE_TU_VOZ_CLONADA (o usa default)   !!');
    Logger.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    process.exit(1); // Salir si no hay .env
  } else {
    Logger.log("Archivo .env encontrado. Procediendo con la inicialización...");
  }
  --- FIN DEL CÓDIGO COMENTADO O ELIMINADO ---> */

  // Simplemente confiamos en que dotenv lo intente y que Railway provea las variables
  Logger.log("Intentando cargar variables de entorno (si .env existe localmente)...");
  // require('dotenv').config(); // Ya está al inicio del archivo, no hace falta aquí de nuevo.

  // Crear e iniciar la instancia del bot
  try {
    const botInstance = new JavierBot();
    await botInstance.start(); // El método start maneja la verificación y el lanzamiento
  } catch (error) {
    // Aunque start() debería manejar la salida en error, este catch es una salvaguarda.
    Logger.error('main: ❌ Error inesperado durante la inicialización principal.', error);
    process.exit(1);
  }
}


// --- Manejo de Señales del Sistema para Cierre Limpio ---
const handleShutdown = (signal) => {
  Logger.log(`\n👋 Recibida señal ${signal}. Cerrando el Bot de Javier Soto...`);
  // En aplicaciones más complejas, aquí se cerrarían conexiones a DB, etc.
  // Telegraf debería detenerse automáticamente con process.exit.
  // Podríamos llamar a bot.stop() explícitamente si fuera necesario:
  // botInstance.bot.stop(signal); // Necesitaría acceso a la instancia
  process.exit(0); // Salir limpiamente
};

process.on('SIGINT', handleShutdown);  // Captura Ctrl+C
process.on('SIGTERM', handleShutdown); // Captura `kill` (señal de terminación estándar)

// --- Manejo de Errores No Capturados (Último Recurso) ---
process.on('uncaughtException', (error, origin) => {
  Logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  Logger.error(`!!        >>> ERROR NO CAPTURADO (${origin}) <<<        !!`);
  Logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`, error);
  // Salir inmediatamente para evitar estado inconsistente
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  Logger.error(`!! >>> PROMESA RECHAZADA NO MANEJADA <<<                  !!`);
  Logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`, reason);
  // Salir inmediatamente
  process.exit(1);
});

// --- Iniciar la aplicación ---
main();
