import { Rpc } from "@opencode/plugin/rpc"

/** Sin argumentos. */
const VACIO = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/** Estado de la voz: si está hablando, si el audio está encolado pero todavía no suena, si está en pausa, si está silenciada, el género y la voz de lectura, el motor de dictado, si el eco está prendido y el modo entre sesiones. */
const ESTADO = {
  type: "object",
  properties: {
    hablando: { type: "boolean" },
    enCola: { type: "boolean" },
    sintetizando: { type: "boolean" },
    reproduciendo: { type: "boolean" },
    pausado: { type: "boolean" },
    silenciado: { type: "boolean" },
    genero: { type: "string" },
    vozTts: { type: "string" },
    motorVoz: { type: "string" },
    motor: { type: "string" },
    eco: { type: "boolean" },
    concurrencia: { type: "string" },
  },
  required: ["hablando", "enCola", "pausado", "silenciado", "genero", "motor", "eco", "concurrencia"],
  additionalProperties: false,
} as const

/** Entrada para transcribir un audio grabado en la app de escritorio. */
const AUDIO_ENTRADA = {
  type: "object",
  properties: {
    audioBase64: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["audioBase64", "mimeType"],
  additionalProperties: false,
} as const

/** Resultado de la transcripción. */
const TRANSCRIPCION = {
  type: "object",
  properties: {
    text: { type: "string" },
    error: { type: "string" },
  },
  required: ["text"],
  additionalProperties: false,
} as const

/** Entrada opcional con el id de sesión para repetir el último mensaje de esa charla. */
const REPETIR_ENTRADA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  additionalProperties: false,
} as const

/** Entrada con el id de la sesión de chat. */
const SESION_ENTRADA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

/** Posición y cantidad de audios guardados para navegarlos. */
const ESTADO_AUDIOS = {
  type: "object",
  properties: {
    actual: { type: "number" },
    total: { type: "number" },
  },
  required: ["actual", "total"],
  additionalProperties: false,
} as const

/** Entrada para moverse entre los audios guardados de una sesión. */
const MOVER_AUDIO_ENTRADA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    direccion: { type: "number" },
  },
  required: ["direccion"],
  additionalProperties: false,
} as const

/** Si hay audio o texto de la última respuesta guardado para repetir en esa sesión. */
const TIENE_VOZ = {
  type: "object",
  properties: { tiene: { type: "boolean" } },
  required: ["tiene"],
  additionalProperties: false,
} as const

/** Si el plugin de voz está apagado en esa sesión. */
const SESION_APAGADA = {
  type: "object",
  properties: {
    apagada: { type: "boolean" },
  },
  required: ["apagada"],
  additionalProperties: false,
} as const

/** Entrada para agregar una palabra o frase al vocabulario de dictado. */
const VOCAB_ENTRADA = {
  type: "object",
  properties: {
    termino: { type: "string" },
  },
  required: ["termino"],
  additionalProperties: false,
} as const

/** Resultado de agregar al vocabulario de dictado. */
const VOCAB_RESULTADO = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    agregado: { type: "boolean" },
    termino: { type: "string" },
    total: { type: "number" },
    error: { type: "string" },
  },
  required: ["ok", "agregado", "termino", "total"],
  additionalProperties: false,
} as const

/** Lista actual del vocabulario de dictado. */
const VOCAB_LISTA = {
  type: "object",
  properties: {
    terminos: { type: "array", items: { type: "string" } },
    ruta: { type: "string" },
  },
  required: ["terminos", "ruta"],
  additionalProperties: false,
} as const

/** Avisa si el usuario está con el dictado abierto para no reproducir voz encima. */
const DICTADO_ESTADO = {
  type: "object",
  properties: {
    activo: { type: "boolean" },
  },
  required: ["activo"],
  additionalProperties: false,
} as const

/** Mensaje de diagnóstico de la lectura remota. */
const DIAGNOSTICO = {
  type: "object",
  properties: { mensaje: { type: "string" } },
  required: ["mensaje"],
  additionalProperties: false,
} as const

/** Texto que un servidor remoto manda leer en la máquina del usuario. */
const TEXTO_PARA_LEER = {
  type: "object",
  properties: {
    texto: { type: "string" },
    sessionID: { type: "string" },
    msgId: { type: "string" },
  },
  required: ["texto"],
  additionalProperties: false,
} as const

/** Datos del turno terminado, incluyendo el hilo que habló. */
const TURNO_TERMINADO = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  additionalProperties: false,
} as const

/** Sesión cuyo audio terminó de reproducirse. */
const LECTURA_TERMINADA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  additionalProperties: false,
} as const

/**
 * Puente entre la parte gráfica (la app de escritorio) y el motor de voz
 * (el servidor). La parte gráfica no puede matar procesos ni leer las claves
 * locales, así que delega en el servidor tanto la reproducción como la
 * transcripción del dictado.
 */
export const Voz = Rpc.define({
  id: "voz",
  methods: {
    /** Pausa el audio o lo retoma desde donde quedó. */
    pausar: { input: VACIO, output: ESTADO },
    /** Repite el último mensaje leído (de la sesión indicada). */
    repetir: { input: REPETIR_ENTRADA, output: ESTADO },
    /** Corta el audio ahora. */
    parar: { input: VACIO, output: ESTADO },
    /** Devuelve el estado actual. */
    estado: { input: VACIO, output: ESTADO },
    /** Silencia o vuelve a activar la lectura. */
    alternar: { input: VACIO, output: ESTADO },
    /** Alterna entre voz femenina y voz masculina. */
    cambiarGenero: { input: VACIO, output: ESTADO },
    /** Alterna la lectura entre Edge (internet) y la voz local de macOS. */
    cambiarMotorVoz: { input: VACIO, output: ESTADO },
    /** Rota el motor de dictado entre automático, ElevenLabs y Groq. */
    cambiarMotor: { input: VACIO, output: ESTADO },
    /** Prende o apaga el eco del usuario, "Trabajando." y avisos de herramientas. */
    alternarEco: { input: VACIO, output: ESTADO },
    /** Alterna entre cortar el audio de otra sesión o esperar turno. */
    alternarConcurrencia: { input: VACIO, output: ESTADO },
    /** Apaga o prende el plugin de voz completo (lectura y micrófono) en una sesión. */
    alternarApagado: { input: SESION_ENTRADA, output: SESION_APAGADA },
    /** Consulta si el plugin está apagado en esa sesión. */
    estadoSesion: { input: SESION_ENTRADA, output: SESION_APAGADA },
    /** Consulta si hay voz guardada para repetir en esa sesión. */
    tieneVoz: { input: SESION_ENTRADA, output: TIENE_VOZ },
    /** Consulta la posición y cantidad de audios guardados en esa sesión. */
    estadoAudios: { input: SESION_ENTRADA, output: ESTADO_AUDIOS },
    /** Reproduce el audio anterior o siguiente (dirección -1 / +1). */
    moverAudio: { input: MOVER_AUDIO_ENTRADA, output: ESTADO },
    /** Marca que el próximo mensaje del usuario se envía desde el dictado por voz. */
    marcarDictado: { input: VACIO, output: ESTADO },
    /** Transcribe audio grabado por el usuario con ElevenLabs o Groq. */
    transcribir: { input: AUDIO_ENTRADA, output: TRANSCRIPCION },
    /** Reproduce el sonido de envío cuando se manda una transcripción. */
    sonidoEnvio: { input: VACIO, output: VACIO },
    /** Reproduce el sonido al iniciar una grabación de dictado. */
    sonidoInicioDictado: { input: VACIO, output: VACIO },
    /** Reproduce el sonido al cortar la grabación del dictado. */
    sonidoFinGrabacion: { input: VACIO, output: VACIO },
    /** Beep suave al cortar un tramo por silencio (espera a que termine de sonar). */
    sonidoCorteTramo: { input: VACIO, output: VACIO },
    /** Reproduce un beep largo y agudo cuando el dictado no captó voz o falló. */
    sonidoSinVoz: { input: VACIO, output: VACIO },
    /** Agrega una palabra o frase al vocabulario de dictado. */
    agregarVocabulario: { input: VOCAB_ENTRADA, output: VOCAB_RESULTADO },
    /** Devuelve las palabras actuales del vocabulario de dictado. */
    listarVocabulario: { input: VACIO, output: VOCAB_LISTA },
    /** Indica al servidor si el dictado está abierto para bloquear lectura y avisos. */
    estadoDictado: { input: DICTADO_ESTADO, output: ESTADO },
    /** Lee en voz alta en esta máquina un texto que mandó un servidor remoto. */
    leerTexto: { input: TEXTO_PARA_LEER, output: ESTADO },
    /** Anota un paso de la lectura remota para diagnosticarla. */
    logDiagnostico: { input: DIAGNOSTICO, output: VACIO },
  },
  events: {
    /** Avisa a la parte gráfica cada vez que cambia el estado. */
    estado: { schema: ESTADO },
    /** Avisa cuando termina de leer en voz alta una respuesta del asistente. */
    lecturaTerminada: { schema: LECTURA_TERMINADA },
    /** Avisa cuando el asistente terminó de responder y de leer en voz alta un turno. */
    turnoTerminado: { schema: TURNO_TERMINADO },
    /** Pide a la parte gráfica que lea un texto en la máquina del usuario. */
    textoParaLeer: { schema: TEXTO_PARA_LEER },
  },
})
