import { Command, ComposerPill, Plugin, Style, type ComposerPillView } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, getOwner, onCleanup, onMount, runWithOwner } from "solid-js"
import { Voz } from "./rpc.js"

type Estado = {
  hablando: boolean
  enCola?: boolean
  sintetizando?: boolean
  reproduciendo?: boolean
  pausado: boolean
  silenciado: boolean
  genero?: "fem" | "masc"
  vozTts?: string
  motorVoz?: string
  motor?: "auto" | "elevenlabs" | "groq"
  eco?: boolean
  concurrencia?: "cortar" | "esperar"
}
type EstadoDictado = "libre" | "grabando" | "transcribiendo" | "confirmar"
type FasePopup = "abriendo" | "grabando" | "transcribiendo" | "confirmar" | "error"
type EstadoVoz = "esperando" | "hablando" | "pausa"

const VAD_TICK_MS = 100
const VAD_CALIBRACION_TICKS = 10
const VAD_ESTABILIZACION_MS = 500
const VAD_CALIBRACION_RETRASO_MS = 700
const VAD_MIN_VOZ_MS = 200
const VAD_UMBRAL_MIN = 0.006
const VAD_MULTIPLICADOR_RUIDO = 2.1
const AUTO_MIC_STORAGE_KEY = "opencode-voz.autoMic"
const AUTO_MIC_RETRASO_MS = 400
const AUTO_MIC_PAUSA_TECLADO_MS = 4000
const AUTO_MIC_SIN_VOZ_MS = 8000
const AUTO_MIC_ESTABILIZACION_MS = 500
const AUTO_MIC_UMBRAL_MIN = 0.009
const AUTO_MIC_MULTIPLICADOR_RUIDO = 2.1
const AUTO_MIC_MIN_VOZ_MS = 200
/** Paciencia del VAD: mínimo 5 s, tope 8 s aunque el ajuste de espera sea mayor. */
const PACIENCIA_MIN_MS = 5000
const PACIENCIA_MAX_MS = 8000
/** Base de la paciencia, con piso de 5 s aunque "Espera para enviar" esté en 3 s. */
const pacienciaBase = () => Math.max(PACIENCIA_MIN_MS, (leerEsperaSeg() || 3) * 1000)
/** El recorder entrega un trozo cada 2 s; así siempre hay audio suficiente para transcribir. */
const STT_TROZO_MS = 2000
/** Tramos más cortos que esto no se mandan al STT: audio casi vacío y Groq alucina. */
const TRAMO_MIN_MS = 2000
/** Groq factura cualquier audio de menos de 10 s como 10 s: no gastes en trozos casi vacíos. */
const STT_MIN_SEGUNDOS = 2
const ESPERA_STORAGE_KEY = "opencode-voz.esperaDictado"
const ESPERA_DEFECTO_SEG = 5
const ESPERA_MIN_SEG = 1
const ESPERA_MAX_SEG = 20

function leerEsperaSeg(): number {
  try {
    const valor = Number(window.localStorage.getItem(ESPERA_STORAGE_KEY))
    if (Number.isFinite(valor) && valor >= ESPERA_MIN_SEG && valor <= ESPERA_MAX_SEG) return Math.round(valor)
  } catch {
    // ignora si localStorage no está disponible
  }
  return ESPERA_DEFECTO_SEG
}

function guardarEsperaSeg(valor: number) {
  try {
    window.localStorage.setItem(ESPERA_STORAGE_KEY, String(valor))
  } catch {
    // ignora si localStorage no está disponible
  }
}

function leerAutoMic(): boolean {
  try {
    return window.localStorage.getItem(AUTO_MIC_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function guardarAutoMic(valor: boolean) {
  try {
    window.localStorage.setItem(AUTO_MIC_STORAGE_KEY, valor ? "1" : "0")
  } catch {
    // ignora si localStorage no está disponible
  }
}

function normalizarParaComando(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¡!¿?.,;:()[\]"'«»…-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function esComandoDejarDeEscuchar(texto: string): boolean {
  const normalizado = normalizarParaComando(texto)
  return normalizado === "dejar de escuchar" || normalizado === "deja de escuchar"
}

/**
 * Para la revisión del texto acumulado: la frase cuenta como comando solo si
 * cierra lo que dijiste. Si la nombrás en medio ("no dije la palabra dejar de
 * escuchar...") no debe disparar: eso fue un falso positivo el 27/11.
 */
function terminaConComandoDeEscuchar(texto: string): boolean {
  return /(?:dejar|deja)\s+de\s+escuchar$/iu.test(normalizarParaComando(texto))
}

/** Saca solo la frase comando final para que no se envíe como mensaje. */
function quitarComandoDeEscuchar(texto: string): string {
  return texto
    .replace(/\b(?:dejar|dej[áa])\s+de\s+escuchar\b[.!?¡!…]*\s*$/iu, "")
    .replace(/\s+/g, " ")
    .trim()
}

const ESTILOS_DICTADO = `
@keyframes opencode-voz-pulso {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.8); }
}
.opencode-voz-dot {
  width: 10px;
  height: 10px;
  border-radius: 9999px;
  background: #ef4444;
  display: inline-block;
  flex-shrink: 0;
  animation: opencode-voz-pulso 1.1s ease-in-out infinite;
}
body:has(.opencode-voz-dictado) [data-slot="dialog-overlay"],
body:has(.opencode-voz-dictado) [data-component="dialog-overlay"] {
  background: transparent !important;
  backdrop-filter: none !important;
  pointer-events: none !important;
}
/* El velo y la capa del diálogo dejan pasar la rueda del mouse hacia la charla. */
body:has(.opencode-voz-dictado) [data-dialog-layer] {
  pointer-events: none !important;
}
body:has(.opencode-voz-dictado) [data-slot="dialog-container"] {
  pointer-events: auto !important;
}
/* Popup compacto: menos alto para poder leer la charla de arriba mientras se dicta. */
body:has(.opencode-voz-dictado) [data-slot="dialog-header"] {
  padding: 6px 12px 0 !important;
  gap: 2px !important;
}
body:has(.opencode-voz-dictado) [data-slot="dialog-description"] {
  display: none !important;
}
body:has(.opencode-voz-dictado) [data-slot="dialog-content"] {
  padding: 2px 12px !important;
}
body:has(.opencode-voz-dictado) [data-slot="dialog-footer"] {
  margin-top: 0 !important;
  padding: 2px 12px 8px !important;
}
.opencode-voz-dictado-grabando > div {
  padding: 5px 2px !important;
  gap: 6px !important;
}
/* Dictar: mismo estilo que Escuchar, pero todo en rojo (borde y letra, fondo transparente). */
button[aria-label="Grabar mensaje de voz y enviarlo"],
button[title="Grabar mensaje de voz y enviarlo"] {
  background: transparent !important;
  border-color: #ef4444 !important;
  box-shadow: inset 0 0 0 1px #ef4444 !important;
  color: #ef4444 !important;
}
button[aria-label="Grabar mensaje de voz y enviarlo"] *,
button[title="Grabar mensaje de voz y enviarlo"] * {
  color: #ef4444 !important;
}
button[aria-label="Grabar mensaje de voz y enviarlo"]:hover,
button[title="Grabar mensaje de voz y enviarlo"]:hover {
  background: rgba(239, 68, 68, 0.3) !important;
}
button[aria-label="Grabar mensaje de voz y enviarlo"]:active,
button[title="Grabar mensaje de voz y enviarlo"]:active {
  background: rgba(239, 68, 68, 0.45) !important;
  color: #fecaca !important;
}
button[aria-label="Frenar la grabación y enviar el mensaje"],
button[title="Frenar la grabación y enviar el mensaje"] {
  background: rgba(239, 68, 68, 0.38) !important;
  border-color: #ef4444 !important;
  color: #fecaca !important;
}
/* Escuchar: borde verde e ícono verde, con el mismo hover al 30% que Dictar. */
button[aria-label^="Reproducir el audio seleccionado"],
button[title^="Reproducir el audio seleccionado"] {
  background: transparent !important;
  border-color: #22c55e !important;
  box-shadow: inset 0 0 0 1px #22c55e !important;
  color: #22c55e !important;
}
button[aria-label^="Reproducir el audio seleccionado"] *,
button[title^="Reproducir el audio seleccionado"] * {
  color: #22c55e !important;
}
button[aria-label^="Reproducir el audio seleccionado"]:hover,
button[title^="Reproducir el audio seleccionado"]:hover {
  background: rgba(34, 197, 94, 0.3) !important;
}
button[aria-label^="Reproducir el audio seleccionado"]:active,
button[title^="Reproducir el audio seleccionado"]:active {
  background: rgba(34, 197, 94, 0.45) !important;
  color: #bbf7d0 !important;
}
/* Fondo al 80% en los botones del plugin (Dictar en reposo conserva el suyo).
   Se prueba tanto title como aria-label porque el host puede exponer cualquiera de los dos. */
button:is(
  [title^="Reproducir el audio seleccionado"], [aria-label^="Reproducir el audio seleccionado"],
  [title="Grabar mensaje de voz y enviarlo"], [aria-label="Grabar mensaje de voz y enviarlo"],
  [title^="Reproducir la respuesta"], [aria-label^="Reproducir la respuesta"],
  [title^="No hay respuesta"], [aria-label^="No hay respuesta"],
  [title^="No hay voz grabada"], [aria-label^="No hay voz grabada"],
  [title="Cortar la reproducción ahora"], [aria-label="Cortar la reproducción ahora"],
  [title="Volver a activar la lectura en voz alta"], [aria-label="Volver a activar la lectura en voz alta"],
  [title="Pausar la lectura en voz alta"], [aria-label="Pausar la lectura en voz alta"],
  [title="Seguir la lectura desde donde quedó"], [aria-label="Seguir la lectura desde donde quedó"],
  [title="Audio esperando para sonar: arranca apenas esté libre el turno. Stop lo cancela"],
  [title="Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar"],
  [aria-label="Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar"],
  [title^="Plugin de voz apagado"], [aria-label^="Plugin de voz apagado"],
  [title="Enviar el texto que dejaste en el compositor"], [aria-label="Enviar el texto que dejaste en el compositor"],
  [title="Tocá para cancelar el envío automático y editar el texto"],
  [aria-label="Tocá para cancelar el envío automático y editar el texto"],
  [title="Frenar la grabación y enviar el mensaje"], [aria-label="Frenar la grabación y enviar el mensaje"],
  [title="Descartar la grabación y volver a los botones normales"],
  [aria-label="Descartar la grabación y volver a los botones normales"],
  [title="Cancelar el envío automático y conservar el texto para editarlo"],
  [aria-label="Cancelar el envío automático y conservar el texto para editarlo"],
  [title="Pausar la grabación"], [aria-label="Pausar la grabación"],
  [title="Seguir grabando"], [aria-label="Seguir grabando"],
  [title="Transcribiendo el audio"], [aria-label="Transcribiendo el audio"],
  [title="Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar"],
  [aria-label="Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar"],
  [title="Transcribiendo el audio: se habilita para enviar cuando termine"],
  [aria-label="Transcribiendo el audio: se habilita para enviar cuando termine"],
  [title="Ya hay audio utilizable para transcribir"], [aria-label="Ya hay audio utilizable para transcribir"],
  [title="Todavía no hay audio utilizable para transcribir"],
  [aria-label="Todavía no hay audio utilizable para transcribir"],
  [title="Nivel del micrófono y cuenta para el envío automático por silencio"],
  [aria-label="Nivel del micrófono y cuenta para el envío automático por silencio"],
  [title^="Ajustes de voz"], [aria-label^="Ajustes de voz"], [aria-label="Ajustes"],
  [title="Charla contínua prendida: el micrófono se abre solo tras cada respuesta. Clic para apagarla"],
  [aria-label="Charla contínua prendida: el micrófono se abre solo tras cada respuesta. Clic para apagarla"]
) {
  opacity: 0.8 !important;
}
/* Fondo gris semitransparente en los que no traen un fondo propio (flechas, Ajustes y dictado). */
button:is(
  [title^="Reproducir la respuesta"], [aria-label^="Reproducir la respuesta"],
  [title^="No hay respuesta"], [aria-label^="No hay respuesta"],
  [title^="Ajustes de voz"], [aria-label^="Ajustes de voz"], [aria-label="Ajustes"],
  [title="Descartar la grabación y volver a los botones normales"],
  [aria-label="Descartar la grabación y volver a los botones normales"],
  [title="Cancelar el envío automático y conservar el texto para editarlo"],
  [aria-label="Cancelar el envío automático y conservar el texto para editarlo"],
  [title="Pausar la grabación"], [aria-label="Pausar la grabación"],
  [title="Seguir grabando"], [aria-label="Seguir grabando"],
  [title="Transcribiendo el audio"], [aria-label="Transcribiendo el audio"],
  [title="Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar"],
  [aria-label="Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar"],
  [title="Transcribiendo el audio: se habilita para enviar cuando termine"],
  [aria-label="Transcribiendo el audio: se habilita para enviar cuando termine"],
  [title="Ya hay audio utilizable para transcribir"], [aria-label="Ya hay audio utilizable para transcribir"],
  [title="Todavía no hay audio utilizable para transcribir"],
  [aria-label="Todavía no hay audio utilizable para transcribir"],
  [title="Nivel del micrófono y cuenta para el envío automático por silencio"],
  [aria-label="Nivel del micrófono y cuenta para el envío automático por silencio"]
) {
  background-color: rgba(148, 163, 184, 0.16) !important;
}
/* Ajustes: recuadro negro para hacer juego con los otros botones. */
button[title^="Ajustes de voz"],
button[aria-label^="Ajustes de voz"],
button[aria-label="Ajustes"] {
  border-color: #000000 !important;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.85) !important;
}
/* Pills sin acción: texto gris en vez de blanco. */
button[aria-disabled="true"],
button[disabled],
button[aria-label="No hay respuesta anterior"],
button[title="No hay respuesta anterior"],
button[aria-label="No hay respuesta siguiente"],
button[title="No hay respuesta siguiente"],
button[aria-label="No hay voz grabada para repetir en esta sesión"],
button[title="No hay voz grabada para repetir en esta sesión"],
button[aria-label="Transcribiendo el audio: se habilita para enviar cuando termine"],
button[title="Transcribiendo el audio: se habilita para enviar cuando termine"],
button[aria-disabled="true"] *,
button[disabled] *,
button[aria-label="No hay respuesta anterior"] *,
button[title="No hay respuesta anterior"] *,
button[aria-label="No hay respuesta siguiente"] *,
button[title="No hay respuesta siguiente"] *,
button[aria-label="No hay voz grabada para repetir en esta sesión"] *,
button[title="No hay voz grabada para repetir en esta sesión"] *,
button[aria-label="Transcribiendo el audio: se habilita para enviar cuando termine"] *,
button[title="Transcribiendo el audio: se habilita para enviar cuando termine"] * {
  color: #8b93a5 !important;
}
/* Flechas de navegación: amarillas cuando hay adónde ir. */
button[aria-label^="Reproducir la respuesta"],
button[title^="Reproducir la respuesta"],
button[aria-label^="Reproducir la respuesta"] *,
button[title^="Reproducir la respuesta"] * {
  color: #facc15 !important;
}
`

/** Ícono propio de pausa (dos palitos): la app no tiene ícono de pausa. */
const ICONO_PAUSA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3.2" height="10" rx="1.2" fill="currentColor"/><rect x="8.8" y="3" width="3.2" height="10" rx="1.2" fill="currentColor"/></svg>`

/** Ícono estándar de grabar: un redondito (la app no trae uno propio). */
const ICONO_GRABAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg>`

function formatoSegundos(total: number): string {
  const mins = String(Math.floor(total / 60)).padStart(2, "0")
  const secs = String(total % 60).padStart(2, "0")
  return `${mins}:${secs}s`
}

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = typeof reader.result === "string" ? reader.result : ""
      const coma = res.indexOf(",")
      resolve(coma >= 0 ? res.slice(coma + 1) : res)
    }
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el audio grabado"))
    reader.readAsDataURL(blob)
  })
}

export default Plugin.define({
  icons: { pausa: ICONO_PAUSA, grabar: ICONO_GRABAR },
  setup(ctx) {
    const rootOwner = getOwner()
    let desmontado = false
    ctx.add(Style, ESTILOS_DICTADO)

    const [estado, setEstado] = createSignal<Estado>({
      hablando: false,
      enCola: false,
      sintetizando: false,
      reproduciendo: false,
      pausado: false,
      silenciado: false,
      genero: "fem",
      motor: "auto",
      eco: true,
      concurrencia: "cortar",
    })
    const [dictado, setDictado] = createSignal<EstadoDictado>("libre")
    const [segundos, setSegundos] = createSignal(0)
    const [autoMic, setAutoMic] = createSignal(leerAutoMic())
    const [pulsoVoz, setPulsoVoz] = createSignal(false)
    const [sesionesSinVoz, setSesionesSinVoz] = createSignal<ReadonlySet<string>>(new Set())
    const [audios, setAudios] = createSignal({ actual: 0, total: 0 })

    let grabadora: MediaRecorder | undefined
    let flujoMic: MediaStream | undefined
    let fragmentos: Blob[] = []
    let timerTranscripcionParcial: ReturnType<typeof setInterval> | undefined
    let transcripcionParcialEnVuelo = false
    let textoParcialAcumulado = ""
    let textoParcialUltimo = ""
    // Borrador original del compositor, capturado una sola vez por dictado. La
    // vista previa se recalcula desde acá para no duplicar el texto al enviar.
    let textoBaseVista: string | undefined
    let vistaPreviaTexto = ""
    let omitirTranscripcionFinal = false
    // Corte de tramo: al silencio se PARA el recorder, se transcribe ese audio
    // una sola vez y se arranca otro MediaRecorder distinto sobre el mismo mic.
    let cortePorSilencio = false
    let mimeGrabacion = ""
    // El VAD prende esto en cuanto oye voz dentro del tramo actual. Los tramos
    // de silencio se descartan: Groq los transcribe como "Gracias." inventado.
    let vozEnTramo = false
    // El sonido de cierre se toca recién en onstop, cuando el blob ya se cerró,
    // para que el clic no se cuele en el audio que va al STT.
    let sonarFinAlParar = false
    let timerGrabacion: ReturnType<typeof setInterval> | undefined
    let timerAutoMic: ReturnType<typeof setTimeout> | undefined
    let timerPulso: ReturnType<typeof setInterval> | undefined
    let dialogoAbierto = false
    let detenerActivo: (() => void) | undefined
    let ultimaTeclaEn = 0

    const cancelarTimerAutoMic = () => {
      if (timerAutoMic) {
        clearTimeout(timerAutoMic)
        timerAutoMic = undefined
      }
    }

    // Hace parpadear el icono de la pill de voz mientras se reproduce audio.
    createEffect(() => {
      if (!estado().hablando || estado().pausado) {
        if (timerPulso) {
          clearInterval(timerPulso)
          timerPulso = undefined
        }
        setPulsoVoz(false)
        return
      }
      if (!timerPulso) {
        timerPulso = setInterval(() => setPulsoVoz((valor) => !valor), 1000)
      }
      onCleanup(() => {
        if (timerPulso) {
          clearInterval(timerPulso)
          timerPulso = undefined
        }
      })
    })

    const teclasIgnoradas = new Set([
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
      "Home",
      "End",
    ])

    const esCampoTexto = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false
      if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
      if (el instanceof HTMLInputElement) {
        const tipo = (el.type || "text").toLowerCase()
        return !el.readOnly && !el.disabled && ["text", "search", "url", "email"].includes(tipo)
      }
      return el.isContentEditable
    }

    const textoEnCampo = (el: HTMLElement): string => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return el.value.trim()
      }
      return (el.textContent ?? "").replace(/\u200b/g, "").trim()
    }

    const usuarioEscribiendo = (): boolean => {
      if (Date.now() - ultimaTeclaEn < AUTO_MIC_PAUSA_TECLADO_MS) return true
      const activo = document.activeElement
      if (esCampoTexto(activo) && textoEnCampo(activo).length > 0) return true
      return false
    }

    const onTeclaUsuario = (e: KeyboardEvent) => {
      if (dialogoAbierto || e.metaKey || e.ctrlKey || e.altKey) return
      if (teclasIgnoradas.has(e.key)) return
      const objetivo = e.target instanceof Element ? e.target : document.activeElement
      if (!esCampoTexto(objetivo)) return
      if (e.key === "Enter" && !e.shiftKey) {
        ultimaTeclaEn = 0
        // Después de enviar, la app puede dejar el foco en la última pill tocada
        // (p. ej. Ajustes). Lo devolvemos al cuadro de escritura.
        setTimeout(enfocarCuadroTexto, 0)
        setTimeout(enfocarCuadroTexto, 150)
        return
      }
      ultimaTeclaEn = Date.now()
      cancelarTimerAutoMic()
    }
    window.addEventListener("keydown", onTeclaUsuario, true)

    const soltarFocoBoton = () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    }

    const enfocarCuadroTexto = () => {
      const enfocar = () => {
        if (desmontado || dialogoAbierto) return
        ctx.screen.current()?.composer.focus()
      }
      setTimeout(enfocar, 0)
      setTimeout(enfocar, 60)
    }

    const desactivarAutoMic = () => {
      setAutoMic(false)
      guardarAutoMic(false)
      cancelarTimerAutoMic()
    }

    const alternarAutoMic = () => {
      soltarFocoBoton()
      const nuevo = !autoMic()
      setAutoMic(nuevo)
      guardarAutoMic(nuevo)
      if (!nuevo) cancelarTimerAutoMic()
      enfocarCuadroTexto()
    }

    type Servidor = NonNullable<ReturnType<typeof ctx.sessions.current>>["server"]

    /**
     * Cliente del servidor dueño de la sesión. `ctx.client` es el servidor local de la app:
     * en remoto no conoce las carpetas del servidor y responde "Location not found".
     */
    const voz = (server?: Servidor) => ((server ?? ctx.sessions.current()?.server)?.client ?? ctx.client).rpc(Voz)
    const sesionRemota = () => {
      const server = ctx.sessions.current()?.server
      return Boolean(server && !server.builtin)
    }
    const carpetaActual = () => ctx.sessions.current()?.directory
    const opciones = (directory?: string) => {
      const dir = directory ?? carpetaActual()
      return dir ? { location: { directory: dir } } : undefined
    }

    /**
     * El dictado en remoto se transcribe en esta máquina, donde están las claves de
     * ElevenLabs y Groq: el servidor remoto puede no tenerlas. Si acá no está el
     * plugin, prueba en el servidor de la sesión.
     */
    const transcribirDictado = async (
      server: Servidor,
      directory: string | undefined,
      audioBase64: string,
      mimeType: string,
    ): Promise<{ text: string; error?: string }> => {
      if (!server.builtin) {
        try {
          return (await ctx.client.rpc(Voz).transcribir({ audioBase64, mimeType })) as {
            text: string
            error?: string
          }
        } catch {
          // sin plugin local: sigue con el servidor de la sesión
        }
      }
      return (await voz(server).transcribir({ audioBase64, mimeType }, opciones(directory))) as {
        text: string
        error?: string
      }
    }

    /** Los sonidos tienen que salir por los parlantes de esta máquina, no por el servidor remoto. */
    const vozSonido = (server: Servidor) => (server.builtin ? voz(server) : ctx.client.rpc(Voz))
    const opcionesSonido = (server: Servidor, directory?: string) =>
      server.builtin ? opciones(directory) : undefined

    /**
     * En remoto el plugin que guarda el estado (género, motor, eco, dictado) y reproduce
     * audio es el local: el servidor remoto no tiene el plugin instalado.
     */
    const vozEstado = (server?: Servidor, directory?: string) => {
      const remoto = Boolean(server && !server.builtin)
      return { rpc: remoto ? ctx.client.rpc(Voz) : voz(server), opts: remoto ? undefined : opciones(directory) }
    }

    /**
     * Último mensaje del asistente de una sesión, leído del contexto del servidor.
     * Es la fuente que sobrevive a una recarga: la caché de audios vive en memoria.
     */
    const ultimoTextoDeSesion = async (id: string, server?: Servidor): Promise<string> => {
      if (!server) return ""
      try {
        const mensajes = (await server.client.session.context({ sessionID: id })) as Array<{
          type?: string
          content?: Array<{ type?: string; text?: string }>
        }>
        for (let i = mensajes.length - 1; i >= 0; i--) {
          const m = mensajes[i]
          if (m?.type !== "assistant") continue
          const partes = (m.content ?? [])
            .filter((p) => p?.type === "text" && p.text?.trim())
            .map((p) => p.text as string)
          if (partes.length) return partes.join("\n")
        }
      } catch {
        // sin contexto disponible
      }
      return ""
    }

    const refrescarVozDisponible = async (id: string, server?: Servidor, directory?: string) => {
      try {
        const { rpc, opts } = vozEstado(server, directory)
        const { tiene } = await rpc.tieneVoz({ sessionID: id }, opts)
        if (tiene) {
          setSesionesSinVoz((previo) => {
            const nuevo = new Set(previo)
            nuevo.delete(id)
            return nuevo
          })
          return
        }
        // Sin caché (típico tras recargar): si la sesión tiene un último mensaje, se puede leer igual.
        const texto = await ultimoTextoDeSesion(id, server)
        setSesionesSinVoz((previo) => {
          const nuevo = new Set(previo)
          if (texto.trim()) nuevo.delete(id)
          else nuevo.add(id)
          return nuevo
        })
      } catch {
        // si falla la consulta, dejamos el botón habilitado
      }
    }

    const refrescarAudios = async (id: string, server?: Servidor, directory?: string) => {
      try {
        const { rpc, opts } = vozEstado(server, directory)
        setAudios((await rpc.estadoAudios({ sessionID: id }, opts)) as { actual: number; total: number })
      } catch {
        setAudios({ actual: 0, total: 0 })
      }
    }

    const moverAudio = (id: string, server: Servidor | undefined, directory: string | undefined, direccion: number) => {
      const { rpc, opts } = vozEstado(server, directory)
      cancelarTimerAutoMic()
      void rpc
        .moverAudio({ sessionID: id, direccion }, opts)
        .then(() => refrescarAudios(id, server, directory))
        .catch(() => {})
    }

    const diagPlugin = (mensaje: string) => {
      void ctx.client.rpc(Voz).logDiagnostico({ mensaje }).catch(() => {})
    }

    /** Corta el timer de STT parcial; el texto acumulado se conserva para la revisión al silencio. */
    const detenerTranscripcionParcial = () => {
      if (timerTranscripcionParcial) {
        clearInterval(timerTranscripcionParcial)
        timerTranscripcionParcial = undefined
      }
    }

    const [apagada, setApagada] = createSignal(false)

    const sesionActual = () => ctx.sessions.current()

    const refrescarApagada = async (directory?: string) => {
      const sesion = sesionActual()
      if (!sesion?.id) {
        setApagada(false)
        return
      }
      try {
        const { rpc, opts } = vozEstado(sesion.server, directory)
        const res = (await rpc.estadoSesion({ sessionID: sesion.id }, opts)) as {
          apagada: boolean
        }
        setApagada(res.apagada === true)
      } catch {
        // si el servidor no contesta, deja el estado como está
      }
    }

    const alternarApagada = async (directory?: string) => {
      const sesion = sesionActual()
      if (!sesion?.id) return
      try {
        const { rpc, opts } = vozEstado(sesion.server, directory)
        const res = (await rpc.alternarApagado({ sessionID: sesion.id }, opts)) as {
          apagada: boolean
        }
        setApagada(res.apagada === true)
        if (res.apagada) {
          cancelarTimerAutoMic()
          if (dialogoAbierto && dictado() === "grabando") detenerActivo?.()
        }
      } catch {
        // si el servidor no contesta, no cambia el estado
      }
    }

    const detenerContador = () => {
      if (timerGrabacion) {
        clearInterval(timerGrabacion)
        timerGrabacion = undefined
      }
      setSegundos(0)
    }

    const liberarMic = () => {
      detenerContador()
      if (flujoMic) {
        for (const pista of flujoMic.getTracks()) pista.stop()
        flujoMic = undefined
      }
      grabadora = undefined
    }

    const refrescar = async (directory?: string) => {
      const opts = opciones(directory)
      const remoto = sesionRemota()
      if (!opts && !remoto) return
      try {
        setEstado(
          remoto
            ? ((await ctx.client.rpc(Voz).estado({})) as Estado)
            : ((await voz().estado({}, opts)) as Estado),
        )
      } catch {
        // el servidor todavía no está listo; el próximo sondeo lo resuelve
      }
    }

    const pausar = async (directory?: string) => {
      try {
        setEstado(
          sesionRemota()
            ? ((await ctx.client.rpc(Voz).pausar({})) as Estado)
            : ((await voz().pausar({}, opciones(directory))) as Estado),
        )
      } catch {
        // si el servidor no contesta, no hay audio que pausar
      }
    }

    const repetir = async (directory?: string, sessionID?: string) => {
      const id = sessionID ?? sesionActual()?.id
      const servidor = sesionActual()?.server
      // En remoto el contexto del servidor es la fuente de verdad. En local usamos primero la
      // caché de audios y, si está vacía (pasa tras recargar), caemos al contexto de la sesión.
      let usarContexto = Boolean(servidor && !servidor.builtin)
      if (!usarContexto && servidor && id) {
        try {
          const { rpc, opts } = vozEstado(servidor, directory)
          usarContexto = !((await rpc.tieneVoz({ sessionID: id }, opts)) as { tiene?: boolean }).tiene
          diagPlugin(`repetir sesion=${id} tieneVoz=${!usarContexto}`)
        } catch {
          usarContexto = true
          diagPlugin(`repetir sesion=${id} tieneVoz=error -> contexto`)
        }
      }
      if (servidor && id && usarContexto) {
        // Los eventos pueden venir a trozos (por ordinal) o quedarse con un mensaje anterior,
        // así que el contexto es la fuente de verdad.
        let texto = await ultimoTextoDeSesion(id, servidor)
        const fuente = texto ? "contexto" : "eventos"
        if (!texto) texto = ultimoTextoPorSesion.get(id)?.texto ?? ""
        diagPlugin(`repetir sesion=${id} fuente=${fuente} chars=${texto.length}`)
        if (texto.trim()) {
          const res = (await ctx.client
            .rpc(Voz)
            .leerTexto({ texto, sessionID: id })
            .catch(() => undefined)) as Estado | undefined
          diagPlugin(`repetir leerTexto hablando=${res?.hablando ?? "sin respuesta"}`)
          if (res) setEstado(res)
          return
        }
      }
      try {
        const { rpc, opts } = vozEstado(servidor, directory)
        const res = (await rpc.repetir(id ? { sessionID: id } : {}, opts)) as Estado
        diagPlugin(`repetir cache sesion=${id ?? "-"} hablando=${res.hablando}`)
        setEstado(res)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        diagPlugin(`repetir cache ERROR sesion=${id ?? "-"} ${msg.slice(0, 120)}`)
      }
    }

    const parar = async (directory?: string) => {
      try {
        setEstado(
          sesionRemota()
            ? ((await ctx.client.rpc(Voz).parar({})) as Estado)
            : ((await voz().parar({}, opciones(directory))) as Estado),
        )
      } catch {
        // si el servidor no contesta, no hay audio que cortar
      }
    }

    const alternar = async (directory?: string) => {
      try {
        setEstado(
          sesionRemota()
            ? ((await ctx.client.rpc(Voz).alternar({})) as Estado)
            : ((await voz().alternar({}, opciones(directory))) as Estado),
        )
      } catch {
        // ídem
      }
    }

    const cambiarGenero = async (directory?: string, server?: Servidor) => {
      try {
        const { rpc, opts } = vozEstado(server ?? sesionActual()?.server, directory)
        setEstado((await rpc.cambiarGenero({}, opts)) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el género
      }
    }

    const cambiarMotorVoz = async (directory?: string, server?: Servidor) => {
      try {
        const { rpc, opts } = vozEstado(server ?? sesionActual()?.server, directory)
        setEstado((await rpc.cambiarMotorVoz({}, opts)) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el motor de lectura
      }
    }

    const cambiarMotor = async (directory?: string, server?: Servidor) => {
      try {
        const { rpc, opts } = vozEstado(server ?? sesionActual()?.server, directory)
        setEstado((await rpc.cambiarMotor({}, opts)) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el motor de dictado
      }
    }

    const alternarEco = async (directory?: string, server?: Servidor) => {
      try {
        const { rpc, opts } = vozEstado(server ?? sesionActual()?.server, directory)
        setEstado((await rpc.alternarEco({}, opts)) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el eco
      }
    }

    const alternarConcurrencia = async (directory?: string, server?: Servidor) => {
      try {
        const { rpc, opts } = vozEstado(server ?? sesionActual()?.server, directory)
        const res = (await rpc.alternarConcurrencia({}, opts)) as Estado
        setEstado(res)
        const modo = res.concurrencia === "esperar" ? "esperar" : "cortar"
        ctx.toast.show({
          title:
            modo === "cortar"
              ? "Audio entre hilos: cortar el anterior"
              : "Audio entre hilos: esperar turno",
          variant: "default",
        })
      } catch {
        // si el servidor no contesta, no cambia el modo entre hilos
      }
    }

    const guardarTerminoVocabulario = async (termino: string) => {
      try {
        const { rpc, opts } = vozEstado(sesionActual()?.server, carpetaActual())
        const res = (await rpc.agregarVocabulario({ termino }, opts)) as {
          ok: boolean
          agregado: boolean
          termino: string
          total: number
          error?: string
        }
        if (!res.ok) {
          ctx.toast.show({
            title: "No se pudo guardar en el vocabulario",
            description: res.error,
            variant: "error",
          })
          return
        }
        if (res.agregado) {
          ctx.toast.show({
            title: `Agregado al vocabulario: ${res.termino}`,
            description: `Total: ${res.total}`,
            variant: "success",
          })
          return
        }
        ctx.toast.show({
          title: `Ya estaba en el vocabulario: ${res.termino}`,
          variant: "default",
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.toast.show({ title: "Error al guardar en el vocabulario", description: msg, variant: "error" })
      }
    }

    const abrirDialogoVocabulario = () => {
      soltarFocoBoton()
      setTimeout(() => {
        if (desmontado) return
        runWithOwner(rootOwner, () => {
          ctx.dialogs.open((dialog) => {
            const [termino, setTermino] = createSignal("")
            const [terminos, setTerminos] = createSignal<string[]>([])
            const [cargandoLista, setCargandoLista] = createSignal(true)
            let campo: HTMLInputElement | undefined

            const cerrar = () => {
              dialog.close()
              enfocarCuadroTexto()
            }

            const cargarLista = async () => {
              setCargandoLista(true)
              try {
                const { rpc, opts } = vozEstado(sesionActual()?.server, carpetaActual())
                const res = (await rpc.listarVocabulario({}, opts)) as {
                  terminos: string[]
                  ruta: string
                }
                setTerminos(Array.isArray(res.terminos) ? res.terminos : [])
              } catch {
                setTerminos([])
              } finally {
                setCargandoLista(false)
              }
            }

            const guardar = () => {
              const limpio = termino().trim()
              if (!limpio) return
              cerrar()
              void guardarTerminoVocabulario(limpio)
            }

            onMount(() => {
              void cargarLista()
              setTimeout(() => campo?.focus(), 0)
            })

            return (
              <ctx.ui.Dialog
                title="Vocabulario de voz (/corregir)"
                description="Escribí una palabra o frase nueva para mejorar el dictado. Enter guarda, Escape cierra."
                footer={
                  <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
                    <ctx.ui.Button variant="neutral" onClick={cerrar}>
                      Cerrar
                    </ctx.ui.Button>
                    <ctx.ui.Button variant="contrast" disabled={!termino().trim()} onClick={guardar}>
                      Guardar
                    </ctx.ui.Button>
                  </div>
                }
              >
                <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <input
                    ref={campo}
                    type="text"
                    aria-label="Palabra o frase para el vocabulario"
                    placeholder="Por ejemplo: Charla contínua"
                    value={termino()}
                    onInput={(e) => setTermino(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.isComposing) {
                        e.preventDefault()
                        guardar()
                        return
                      }
                      if (e.key === "Escape") {
                        e.preventDefault()
                        cerrar()
                      }
                    }}
                    style={{
                      width: "100%",
                      padding: "10px",
                      "border-radius": "6px",
                      border: "1px solid currentColor",
                      background: "transparent",
                      color: "inherit",
                      font: "inherit",
                      "box-sizing": "border-box",
                      outline: "none",
                    }}
                  />
                  <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                    <strong style={{ "font-size": "13px" }}>
                      {cargandoLista() ? "Cargando palabras…" : `Palabras guardadas (${terminos().length})`}
                    </strong>
                    <Show
                      when={!cargandoLista() && terminos().length > 0}
                      fallback={
                        <Show when={!cargandoLista()}>
                          <span style={{ opacity: 0.75, "font-size": "13px" }}>
                            Todavía no hay palabras guardadas.
                          </span>
                        </Show>
                      }
                    >
                      <ul
                        style={{
                          margin: "0",
                          padding: "8px 12px 8px 26px",
                          "max-height": "180px",
                          "overflow-y": "auto",
                          "border-radius": "6px",
                          border: "1px solid rgba(128, 128, 128, 0.35)",
                          "font-size": "13px",
                          "line-height": "1.5",
                          "user-select": "text",
                        }}
                      >
                        <For each={terminos()}>{(item) => <li>{item}</li>}</For>
                      </ul>
                    </Show>
                  </div>
                </div>
              </ctx.ui.Dialog>
            )
          })
        })
      }, 0)
    }

    type DestinoDictado = {
      id: string
      directory: string
      server: NonNullable<ReturnType<typeof ctx.sessions.current>>["server"]
    }

    type ControlDictado = {
      detener: () => void
      cancelar: () => void
      pausar: () => void
      cancelarEnvio: () => void
      cancelarConservandoTexto: () => void
      enviarAhora: () => void
      cerrar: () => void
      nivel: () => number
      segundos: () => number
      cuentaSilencio: () => string
      audioUtil: () => boolean
      pausada: () => boolean
      restante: () => number | null
    }
    const [controlDictado, setControlDictado] = createSignal<ControlDictado | undefined>()
    let textoPegado = ""
    let textoVisto = false
    let textoDestinoId = ""
    let timerTextoVacio: ReturnType<typeof setTimeout> | undefined
    const cancelarTimerTextoVacio = () => {
      if (timerTextoVacio) {
        clearTimeout(timerTextoVacio)
        timerTextoVacio = undefined
      }
    }

    const [cuentaRestante, setCuentaRestante] = createSignal<number | null>(null)
    let timerCuenta: ReturnType<typeof setInterval> | undefined
    const pararCuenta = (motivo: string) => {
      if (cuentaRestante() !== null) diagPlugin(`cuenta: cortada (${motivo})`)
      if (timerCuenta) {
        clearInterval(timerCuenta)
        timerCuenta = undefined
      }
      setCuentaRestante(null)
    }
    const iniciarCuenta = () => {
      pararCuenta("reinicio")
      const seg = leerEsperaSeg()
      diagPlugin(`cuenta: iniciada ${seg}s`)
      setCuentaRestante(seg)
      timerCuenta = setInterval(() => {
        const actual = cuentaRestante()
        if (actual === null) {
          pararCuenta("sin valor")
          return
        }
        if (actual <= 1) {
          diagPlugin("cuenta: enviando")
          pararCuenta("envío")
          controlDictado()?.enviarAhora()
          return
        }
        setCuentaRestante(actual - 1)
      }, 1000)
    }

    /** Arma el texto final a partir del borrador guardado, no de lo que hay en el cuadro. */
    const unirConBorrador = (texto: string) => {
      const base = textoBaseVista ?? ""
      const separador = base && !/\s$/.test(base) ? " " : ""
      return `${base}${separador}${texto}`
    }

    const ponerTextoEnCompositor = (texto: string, destino: DestinoDictado) => {
      const composer =
        ctx.sessions.current()?.id === destino.id ? ctx.screen.current()?.composer : undefined
      cancelarTimerTextoVacio()
      // Si ya veníamos previsualizando, el borrador original es el guardado, no
      // lo que el usuario vio en el cuadro (que incluía lo reconocido).
      if (textoBaseVista === undefined) textoBaseVista = composer?.text() ?? ""
      textoPegado = unirConBorrador(texto)
      textoVisto = false
      textoDestinoId = destino.id
      // El seguimiento debe ver el texto completo, no solo lo que dictamos, para
      // que no cancele el envío automático apenas aplica el setText.
      composer?.setText(textoPegado)
    }

    /** Fase 3: muestra lo reconocido hasta ahora sin gastar llamadas al STT. */
    const actualizarVistaPrevia = (texto: string, destino: DestinoDictado) => {
      const composer =
        ctx.sessions.current()?.id === destino.id ? ctx.screen.current()?.composer : undefined
      if (!composer || !texto) return
      if (textoBaseVista === undefined) textoBaseVista = composer.text() ?? ""
      const completo = unirConBorrador(texto)
      if (composer.text() !== completo) composer.setText(completo)
      diagPlugin(`vista-previa chars=${texto.length}`)
    }

    createEffect(() => {
      const actual = ctx.screen.current()?.composer.text()
      if (dictado() !== "confirmar" || actual === undefined || !textoPegado) return
      // Si el foco se movió a otra sesión, no cancelamos: el envío va al hilo original.
      if (textoDestinoId && ctx.sessions.current()?.id !== textoDestinoId) return
      const limpio = actual.trim()
      if (limpio === textoPegado.trim()) {
        textoVisto = true
        cancelarTimerTextoVacio()
        return
      }
      // El setText se aplica en cola: no reaccionamos hasta ver el texto pegado.
      if (!textoVisto) return
      if (limpio === "") {
        // Un compositor vacío puede ser transitorio (re-render, setText en cola).
        // Esperamos antes de cancelar, y nunca cerramos el diálogo: eso dejaría
        // `cerrado = true` y el timer después no podría enviar.
        if (timerTextoVacio) return
        timerTextoVacio = setTimeout(() => {
          timerTextoVacio = undefined
          if (dictado() !== "confirmar") return
          const ahora = ctx.screen.current()?.composer.text()?.trim() ?? ""
          if (ahora !== "") return
          // El texto se fue (lo envió con el botón de OpenCode): cerramos las pills
          // en vez de dejar "Enviar ahora / Cancelar" prendidos para siempre.
          diagPlugin("cuenta: compositor vacío confirmado, cerrando dictado")
          controlDictado()?.cerrar()
        }, 250)
        return
      }
      cancelarTimerTextoVacio()
      diagPlugin(`cuenta: compositor cambió (${limpio.length} chars)`)
      controlDictado()?.cancelarEnvio()
    })

    const abrirDictado = (modoAuto = false, destino?: DestinoDictado) => {
      // El acumulado es por dictado: nunca puede arrastrar texto del anterior.
      textoParcialAcumulado = ""
      textoParcialUltimo = ""
      textoBaseVista = undefined
      vistaPreviaTexto = ""
      vozEnTramo = false
      const actual = ctx.sessions.current()
      if (apagada() && (!destino || actual?.id === destino.id)) {
        if (!modoAuto) ctx.toast.show({ title: "El plugin de voz está apagado en esta sesión", variant: "default" })
        return
      }
      cancelarTimerAutoMic()
      soltarFocoBoton()
      const session: DestinoDictado | undefined =
        destino ?? (actual ? { id: actual.id, directory: actual.directory, server: actual.server } : undefined)
      if (!session) {
        if (!modoAuto) ctx.toast.show({ title: "Abrí una charla para dictar", variant: "error" })
        return
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        if (!modoAuto) ctx.toast.show({ title: "El micrófono no está disponible en esta ventana", variant: "error" })
        return
      }

      // Corta la voz del asistente y pide el micrófono primero en silencio; recién cuando está listo
      // abre el popup y suena el beep para que empiece a grabar sin demora al terminar el sonido.
      const avisarDictado = (activo: boolean) => {
        const { rpc, opts } = vozEstado(session.server, session.directory)
        return rpc
          .estadoDictado({ activo }, opts)
          .then((res) => setEstado(res as Estado))
          .catch(() => {})
      }
      const corteVoz = avisarDictado(true)
      dialogoAbierto = true
      setControlDictado(undefined)
      // Pasamos la barra a modo dictado YA, antes de pedir el micrófono: así no
      // se ve un instante la botonera de reproducción cuando abre Charla contínua.
      setDictado("grabando")

      void (async () => {
        let stream: MediaStream | undefined
        try {
          const streamPromise = navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          })
          await Promise.race([corteVoz, new Promise((r) => setTimeout(r, 250))])
          stream = await streamPromise
          if (desmontado) {
            for (const pista of stream.getTracks()) pista.stop()
            dialogoAbierto = false
            setDictado("libre")
            void avisarDictado(false)
            return
          }
        } catch (error) {
          if (stream) {
            for (const pista of stream.getTracks()) pista.stop()
          }
          dialogoAbierto = false
          setDictado("libre")
          void avisarDictado(false)
          const msg = error instanceof Error ? error.message : String(error)
          ctx.toast.show({
            title: "No se pudo abrir el micrófono",
            description: msg,
            variant: "error",
          })
          return
        }

        const streamListo = stream
        runWithOwner(rootOwner, () => {
          ctx.dialogs.open((dialog) => {
        const [fase, setFase] = createSignal<FasePopup>("grabando")
        const [texto, setTexto] = createSignal("")
        const [mensajeError, setMensajeError] = createSignal("")
        const [esperaSeg, setEsperaSeg] = createSignal(leerEsperaSeg())
        const [restante, setRestante] = createSignal<number | null>(esperaSeg())
        const [estadoVoz, setEstadoVoz] = createSignal<EstadoVoz>("esperando")
        const [nivelMic, setNivelMic] = createSignal(0)
        const [silencioMs, setSilencioMs] = createSignal(0)
        const [pacienciaMs, setPacienciaMs] = createSignal(pacienciaBase())
        const [esperaSinVozMs, setEsperaSinVozMs] = createSignal(0)
        const [grabacionPausada, setGrabacionPausada] = createSignal(false)
        const [audioUtil, setAudioUtil] = createSignal(false)

        let cancelado = false
        let cerrado = false
        let intervaloEnvio: ReturnType<typeof setInterval> | undefined
        let intervaloVad: ReturnType<typeof setInterval> | undefined
        let audioCtx: AudioContext | undefined
        let area: HTMLTextAreaElement | undefined
        let contenedor: HTMLDivElement | undefined
        const estilosGuardados = new Map<HTMLElement, { opacity: string; background: string; backdropFilter: string }>()

        const recordarEstilo = (nodo: HTMLElement) => {
          if (estilosGuardados.has(nodo)) return
          estilosGuardados.set(nodo, {
            opacity: nodo.style.opacity,
            background: nodo.style.background,
            backdropFilter: nodo.style.backdropFilter,
          })
        }

        const restaurarTransparencia = () => {
          for (const [nodo, prev] of estilosGuardados) {
            nodo.style.opacity = prev.opacity
            nodo.style.background = prev.background
            nodo.style.backdropFilter = prev.backdropFilter
          }
          estilosGuardados.clear()
        }

        const aFondoTranslucido = (colorCss: string, alpha: number): string | undefined => {
          const m = colorCss.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/i)
          if (!m) return undefined
          const aOriginal = m[4] !== undefined ? Number(m[4]) : 1
          if (aOriginal <= 0.01) return undefined
          return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
        }

        const aplicarTransparencia = (alphaFondo: number) => {
          const base = contenedor
          if (!base) return
          const ancestros: HTMLElement[] = []
          let actual: HTMLElement | null = base.parentElement
          let pasos = 0
          while (actual && actual !== document.body && actual !== document.documentElement && pasos < 14) {
            pasos += 1
            ancestros.push(actual)
            if (actual.parentElement) {
              actual = actual.parentElement
            } else {
              const root = actual.getRootNode()
              actual = root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null
            }
          }

          // Busca la caja flotante más externa del popup (más chica que la pantalla completa)
          let tarjeta: HTMLElement | null = null
          for (const n of ancestros) {
            const rect = n.getBoundingClientRect()
            const esFlotante =
              rect.width > 120 &&
              rect.height > 60 &&
              rect.width < window.innerWidth * 0.85 &&
              rect.height < window.innerHeight * 0.85
            if (esFlotante) tarjeta = n
          }
          if (!tarjeta) {
            tarjeta =
              ancestros.find(
                (n) =>
                  n.getAttribute("role") === "dialog" ||
                  n.getAttribute("data-component") === "dialog" ||
                  n.getAttribute("data-slot") === "dialog-content",
              ) ?? null
          }

          if (!tarjeta) return

          // Aplica 72 % al fondo real más externo de la tarjeta y vuelve transparentes los fondos duplicados de adentro
          const idxTarjeta = ancestros.indexOf(tarjeta)
          const candidatosFondo = [tarjeta, ...ancestros.slice(0, idxTarjeta).reverse()]
          let fondoAplicado = false
          for (const nodo of candidatosFondo) {
            if (estilosGuardados.has(nodo)) continue
            const tag = nodo.tagName
            if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA") continue
            const bg = window.getComputedStyle(nodo).backgroundColor
            const nuevo = aFondoTranslucido(bg, alphaFondo)
            if (!nuevo) continue
            recordarEstilo(nodo)
            if (!fondoAplicado) {
              nodo.style.setProperty("background", nuevo, "important")
              fondoAplicado = true
            } else {
              nodo.style.setProperty("background", "transparent", "important")
            }
          }
          // También revisa hijos directos de la tarjeta (header / body / footer) sin tocar nuestro contenido ni botones
          for (const hijo of Array.from(tarjeta.children)) {
            if (!(hijo instanceof HTMLElement) || hijo === base || hijo.contains(base)) continue
            const bg = window.getComputedStyle(hijo).backgroundColor
            if (!estilosGuardados.has(hijo) && aFondoTranslucido(bg, alphaFondo)) {
              recordarEstilo(hijo)
              hijo.style.setProperty("background", "transparent", "important")
            }
          }

          const esOverlayPantalla = (nodo: HTMLElement) => {
            const slot = nodo.getAttribute("data-slot") ?? ""
            const comp = nodo.getAttribute("data-component") ?? ""
            if (slot.includes("overlay") || slot.includes("backdrop") || comp.includes("overlay") || comp.includes("backdrop")) {
              return true
            }
            const cs = window.getComputedStyle(nodo)
            if (cs.position !== "fixed" && cs.position !== "absolute") return false
            const rect = nodo.getBoundingClientRect()
            return rect.width >= window.innerWidth * 0.85 && rect.height >= window.innerHeight * 0.85
          }

          for (let i = idxTarjeta + 1; i < ancestros.length; i++) {
            const anc = ancestros[i]
            if (esOverlayPantalla(anc)) {
              recordarEstilo(anc)
              anc.style.setProperty("background", "transparent", "important")
              anc.style.setProperty("backdrop-filter", "none", "important")
            }
          }

          let padre: HTMLElement | null = tarjeta.parentElement
          for (let nivel = 0; nivel < 3 && padre && padre !== document.body; nivel += 1) {
            for (const hijo of Array.from(padre.children)) {
              if (!(hijo instanceof HTMLElement) || hijo === tarjeta || hijo.contains(tarjeta)) continue
              if (esOverlayPantalla(hijo)) {
                recordarEstilo(hijo)
                hijo.style.setProperty("background", "transparent", "important")
                hijo.style.setProperty("backdrop-filter", "none", "important")
              }
            }
            padre = padre.parentElement
          }
        }

        const encontrarTarjeta = (): HTMLElement | undefined =>
          contenedor?.closest<HTMLElement>('[data-slot="dialog-container"]') ?? undefined

        /** Deja el popup pegado arriba del cuadro donde se escribe el mensaje. */
        const colocarSobreComposer = () => {
          const tarjeta = encontrarTarjeta()
          if (!tarjeta) return
          tarjeta.style.translate = ""
          const rect = tarjeta.getBoundingClientRect()
          const composer = document.querySelector<HTMLElement>(
            '[data-component="composer"], [data-component="session-composer-dock"], [data-component="dock-prompt"]',
          )
          const c = composer?.getBoundingClientRect()
          const borde = c && c.top > 80 ? c.top - 10 : window.innerHeight - 150
          tarjeta.style.translate = `0px ${Math.round(borde - rect.bottom)}px`
        }

        // La capa del diálogo ya deja pasar el scroll; esto evita que un clic afuera lo cierre.
        const evitarCierre = (e: Event) => {
          if (!contenedor) return
          const tarjeta = encontrarTarjeta()
          if (!tarjeta || (e.target instanceof Node && tarjeta.contains(e.target))) return
          e.stopPropagation()
          if (e instanceof MouseEvent) e.preventDefault()
        }
        window.addEventListener("pointerdown", evitarCierre, true)
        window.addEventListener("mousedown", evitarCierre, true)
        window.addEventListener("click", evitarCierre, true)

        // El modal de la app se come la rueda y las flechas: se las pasamos al scroll de la charla.
        let chatScroll: HTMLElement | undefined
        const contenedorChat = (): HTMLElement | undefined => {
          if (chatScroll?.isConnected) return chatScroll
          let mejor: HTMLElement | undefined
          for (const el of document.querySelectorAll<HTMLElement>("*")) {
            if (el.closest('[data-slot="dialog-container"]')) continue
            const rect = el.getBoundingClientRect()
            if (rect.width < 300 || rect.height < 200) continue
            const overflow = window.getComputedStyle(el).overflowY
            if (overflow !== "auto" && overflow !== "scroll") continue
            if (el.scrollHeight <= el.clientHeight + 8) continue
            if (!mejor || el.scrollHeight > mejor.scrollHeight) mejor = el
          }
          chatScroll = mejor
          return mejor
        }
        const alRueda = (e: WheelEvent) => {
          if (!contenedor) return
          const tarjeta = encontrarTarjeta()
          if (tarjeta && e.target instanceof Node && tarjeta.contains(e.target)) return
          const chat = contenedorChat()
          if (!chat) return
          e.preventDefault()
          chat.scrollTop += e.deltaY
        }
        const alFlecha = (e: KeyboardEvent) => {
          if (!contenedor) return
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
          const tarjeta = encontrarTarjeta()
          if (
            tarjeta &&
            e.target instanceof HTMLElement &&
            tarjeta.contains(e.target) &&
            e.target.matches("textarea, input, [contenteditable='true']")
          ) {
            return
          }
          const chat = contenedorChat()
          if (!chat) return
          e.preventDefault()
          e.stopPropagation()
          chat.scrollTop += e.key === "ArrowDown" ? 80 : -80
        }
        window.addEventListener("wheel", alRueda, { capture: true, passive: false })
        window.addEventListener("keydown", alFlecha, true)
        const alRedimensionar = () => {
          chatScroll = undefined
          requestAnimationFrame(colocarSobreComposer)
        }
        onCleanup(() => {
          window.removeEventListener("pointerdown", evitarCierre, true)
          window.removeEventListener("mousedown", evitarCierre, true)
          window.removeEventListener("click", evitarCierre, true)
          window.removeEventListener("wheel", alRueda, true)
          window.removeEventListener("keydown", alFlecha, true)
          window.removeEventListener("resize", alRedimensionar)
          encontrarTarjeta()?.style.removeProperty("translate")
        })

        createEffect(() => {
          fase()
          requestAnimationFrame(colocarSobreComposer)
          setTimeout(colocarSobreComposer, 40)
        })

        createEffect(() => {
          fase()
          const alphaFondo = 0.72
          aplicarTransparencia(alphaFondo)
          requestAnimationFrame(() => aplicarTransparencia(alphaFondo))
          setTimeout(() => aplicarTransparencia(alphaFondo), 40)
        })

        const detenerVad = () => {
          if (intervaloVad) {
            clearInterval(intervaloVad)
            intervaloVad = undefined
          }
          if (audioCtx) {
            const ctxAudio = audioCtx
            audioCtx = undefined
            void ctxAudio.close().catch(() => {})
          }
          setNivelMic(0)
          setSilencioMs(0)
          setEsperaSinVozMs(0)
          setPacienciaMs(pacienciaBase())
          setEstadoVoz("esperando")
        }

        /**
         * Transcribe UN tramo (el audio que ya terminó de grabarse) una sola vez
         * y suma su texto al acumulado del mensaje. Nunca reenvía audio anterior.
         */
        const transcribirTramo = async (blob: Blob, mimeType: string) => {
          if (cancelado || cerrado || blob.size < 200) return
          if (transcripcionParcialEnVuelo) return
          transcripcionParcialEnVuelo = true
          try {
            const audioBase64 = await blobABase64(blob)
            if (cancelado || cerrado) return
            const res = await transcribirDictado(session.server, session.directory, audioBase64, mimeType)
            if (cancelado || cerrado) return
            if (res.error) {
              diagPlugin(`tramo error=${res.error.slice(0, 120)}`)
              return
            }
            // Groq le agrega a veces un "Gracias." fantasma DESPUÉS de la frase
            // comando. Eso hace que no se detecte "dejar de escuchar" al final y
            // que el texto quede abajo sin enviarse (reportado por el usuario).
            const crudo = res.text.trim()
            const texto = crudo.replace(/((?:dejar|deja)\s+de\s+escuchar)[.!?…]*\s+gracias[.!?…]*\s*$/iu, "$1").trim()
            if (texto !== crudo) diagPlugin('tramo: "Gracias." fantasma después de la frase, descartado')
            if (!texto) return
            textoParcialAcumulado = textoParcialAcumulado ? `${textoParcialAcumulado} ${texto}` : texto
            textoParcialUltimo = texto
            diagPlugin(`tramo chars=${texto.length} acumulado=${textoParcialAcumulado.length} texto="${texto.slice(0, 80)}"`)
            if (textoParcialAcumulado !== vistaPreviaTexto) {
              vistaPreviaTexto = textoParcialAcumulado
              actualizarVistaPrevia(textoParcialAcumulado, session)
            }
          } catch (error) {
            diagPlugin(`tramo fallo: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            transcripcionParcialEnVuelo = false
          }
        }

        /** Apaga Charla contínua y cierra el mic cuando la frase no manda texto. */
        const apagarEscucha = (motivo: string) => {
          diagPlugin(`tramo ${motivo}: apagando Charla contínua`)
          void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
          desactivarAutoMic()
          detenerVad()
          detenerTranscripcionParcial()
          try {
            if (grabadora && grabadora.state !== "inactive") grabadora.stop()
          } catch {
            // ignora si ya frenó
          }
          liberarMic()
          setDictado("libre")
          cerrarDialogo()
          ctx.toast.show({ title: "Charla contínua desactivada", variant: "default" })
        }

        /**
         * Si el acumulado termina con "dejar de escuchar": apaga Charla contínua
         * o envía el texto sin la frase, según el estado de la pill.
         */
        const procesarFrase = () => {
          if (cancelado || cerrado) return
          if (!terminaConComandoDeEscuchar(textoParcialAcumulado)) return
          diagPlugin("tramo frase detectada al silencio")
          if (!autoMic()) {
            apagarEscucha("comando con la pill apagada")
            return
          }
          const texto = quitarComandoDeEscuchar(textoParcialAcumulado)
          textoParcialAcumulado = ""
          textoParcialUltimo = ""
          if (!texto) {
            // "Dejar de escuchar" dicho solo: no hay mensaje que enviar, pero
            // tiene que dejar de escuchar igual (antes seguía con el mic abierto).
            apagarEscucha("comando sin texto")
            return
          }
          diagPlugin(`tramo comando enviar chars=${texto.length}`)
          textoPegado = ""
          textoVisto = false
          textoDestinoId = ""
          cancelarTimerTextoVacio()
          setTexto(texto)
          setFase("confirmar")
          setDictado("confirmar")
          ponerTextoEnCompositor(texto, session)
          iniciarCuenta()
          // El texto ya está listo: no hace falta transcribir el tramo al cerrar.
          omitirTranscripcionFinal = true
          detenerVad()
          detenerTranscripcionParcial()
          try {
            if (grabadora && grabadora.state !== "inactive") grabadora.stop()
          } catch {
            // ignora si ya frenó
          }
        }

        /**
         * Al silencio del VAD: CORTA el tramo. El onstop se encarga de transcribir
         * ese audio una sola vez y de arrancar un MediaRecorder nuevo.
         */
        const revisarFrasePorSilencio = async () => {
          if (cancelado || cerrado || fase() !== "grabando") return
          if (grabadora && grabadora.state === "recording") {
            cortePorSilencio = true
            diagPlugin("corte: pidiendo stop del recorder al silencio")
            grabadora.stop()
            return
          }
          procesarFrase()
        }

        const iniciarVad = (stream: MediaStream) => {
          detenerVad()
          try {
            const w = window as unknown as {
              AudioContext?: typeof AudioContext
              webkitAudioContext?: typeof AudioContext
            }
            const AudioCtx = w.AudioContext ?? w.webkitAudioContext
            if (!AudioCtx) {
              diagPlugin("vad: sin AudioContext (Web Audio no disponible)")
              return
            }
            const ctxAudio = new AudioCtx()
            audioCtx = ctxAudio
            const fuente = ctxAudio.createMediaStreamSource(stream)
            const analizador = ctxAudio.createAnalyser()
            analizador.fftSize = 2048
            fuente.connect(analizador)

            const datos = new Float32Array(analizador.fftSize)
            let inicioEscucha = performance.now()
            let noiseFloor = 0.004
            let floorSamples = 0
            let spoke = false
            let speechMs = 0
            let rafagaMs = 0
            let silenceSince: number | null = null
            let ticksVad = 0

            intervaloVad = setInterval(() => {
              if (cancelado || cerrado || fase() !== "grabando") {
                detenerVad()
                return
              }
              // Si el AudioContext quedó suspendido (autoplay policy), el analizador
              // devuelve ceros aunque el MediaRecorder sí esté grabando audio.
              if (ctxAudio.state !== "running") {
                void ctxAudio.resume().catch(() => {})
                return
              }
              if (grabacionPausada()) {
                inicioEscucha += VAD_TICK_MS
                silenceSince = null
                setNivelMic(0)
                setSilencioMs(0)
                return
              }
              analizador.getFloatTimeDomainData(datos)
              let suma = 0
              for (let i = 0; i < datos.length; i++) suma += datos[i] * datos[i]
              const rms = Math.sqrt(suma / datos.length)
              setNivelMic(Math.min(100, Math.round(rms * 450)))
              ticksVad += 1
              if (ticksVad % 10 === 0) {
                diagPlugin(`vad: rms=${rms.toFixed(4)} floor=${noiseFloor.toFixed(4)} state=${ctxAudio.state}`)
              }

              const ahora = performance.now()
              const transcurrido = ahora - inicioEscucha

              // Ignora los primeros milisegundos tras el beep para que su eco no suba el piso de ruido ni dispare voz
              const estabilizacionMs = modoAuto ? AUTO_MIC_ESTABILIZACION_MS : VAD_ESTABILIZACION_MS
              if (!spoke && transcurrido < estabilizacionMs) {
                setEsperaSinVozMs(transcurrido)
                return
              }

              // Recién calibra el piso de ruido tras 600 ms (ya sin eco del beep) y con tope bajo
              if (!spoke && transcurrido >= VAD_CALIBRACION_RETRASO_MS && floorSamples < VAD_CALIBRACION_TICKS) {
                const muestra = Math.min(rms, 0.008)
                noiseFloor = Math.max(noiseFloor * 0.9 + muestra * 0.1, 0.002)
                floorSamples += 1
              }

              const umbralMin = modoAuto ? AUTO_MIC_UMBRAL_MIN : VAD_UMBRAL_MIN
              const multiplicador = modoAuto ? AUTO_MIC_MULTIPLICADOR_RUIDO : VAD_MULTIPLICADOR_RUIDO
              const minVozMs = modoAuto ? AUTO_MIC_MIN_VOZ_MS : VAD_MIN_VOZ_MS
              const threshold = Math.max(umbralMin, noiseFloor * multiplicador)

              if (rms > threshold) {
                speechMs += VAD_TICK_MS
                rafagaMs += VAD_TICK_MS
                // Un golpe seco (menos de 200 ms) no debe tirar hacia atrás la cuenta
                // de silencio: recién lo tratamos como voz cuando la ráfaga se sostiene.
                if (rafagaMs >= minVozMs) {
                  if (!spoke) {
                    spoke = true
                    setAudioUtil(true)
                  }
                  vozEnTramo = true
                  setEstadoVoz("hablando")
                  silenceSince = null
                  setSilencioMs(0)
                }
                return
              }

              rafagaMs = 0
              // Sin hablar: el ambiente cambia (ventilador, calle), acomoda el piso de ruido
              if (!spoke) {
                speechMs = Math.max(0, speechMs - VAD_TICK_MS)
                if (transcurrido >= VAD_CALIBRACION_RETRASO_MS) {
                  const muestra = Math.min(rms, 0.008)
                  noiseFloor = Math.max(noiseFloor * 0.96 + muestra * 0.04, 0.002)
                }
                setEsperaSinVozMs(transcurrido)
                if (transcurrido >= AUTO_MIC_SIN_VOZ_MS) {
                  void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
                  cancelar()
                }
                return
              }

              // Paciencia adaptativa con piso de 5 s y tope de 8 s: +1 s a los 9 s
              // de voz, +2 s a los 20 s y +3 s a los 30 s.
              const extra = speechMs > 30000 ? 3000 : speechMs > 20000 ? 2000 : speechMs > 9000 ? 1000 : 0
              const paciencia = Math.min(PACIENCIA_MAX_MS, pacienciaBase() + extra)
              setPacienciaMs(paciencia)

              if (silenceSince === null) {
                silenceSince = ahora
              }
              const callado = ahora - silenceSince
              setSilencioMs(callado)
              if (callado >= 600) setEstadoVoz("pausa")
              if (callado >= paciencia) {
                if (autoMic()) {
                  // Charla contínua prendida: el silencio no cierra el mic, solo revisa lo
                  // transcripto por si dijeron "dejar de escuchar". Lo decide la pill,
                  // aunque el dictado se haya abierto tocando Dictar.
                  silenceSince = ahora
                  void revisarFrasePorSilencio()
                } else {
                  detenerVad()
                  detenerYTranscribir()
                }
              }
            }, VAD_TICK_MS)

            diagPlugin(`vad: iniciado state=${ctxAudio.state}`)
            if (ctxAudio.state === "suspended") {
              void ctxAudio.resume().catch(() => {})
            }
            // Si el VAD no llega a arrancar, la pill queda clavada en "cierra en 8s"
            // y la barra de nivel en 0. Cerramos con aviso en vez de dejarlo colgado.
            setTimeout(() => {
              if (cancelado || cerrado || fase() !== "grabando" || intervaloVad) return
              diagPlugin("vad: no arrancó, cerrando dictado")
              ctx.toast.show({ title: "El micrófono no entregó audio. Intentá de nuevo.", variant: "error" })
              setDictado("libre")
              cerrarDialogo()
            }, 3000)
          } catch (error) {
            diagPlugin(`vad: error ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const pausarAutoEnvio = () => {
          if (intervaloEnvio) {
            clearInterval(intervaloEnvio)
            intervaloEnvio = undefined
          }
          if (restante() !== null) setRestante(null)
        }

        const cerrarDialogo = (liberarBloqueo = true) => {
          if (cerrado) return
          cerrado = true
          dialogoAbierto = false
          detenerActivo = undefined
          setControlDictado(undefined)
          detenerTranscripcionParcial()
          vistaPreviaTexto = ""
          if (intervaloEnvio) {
            clearInterval(intervaloEnvio)
            intervaloEnvio = undefined
          }
          if (liberarBloqueo) void avisarDictado(false)
          textoParcialAcumulado = ""
          textoParcialUltimo = ""
          dialog.close()
          enfocarCuadroTexto()
        }

        const enviar = () => {
          if (cancelado || cerrado) {
            diagPlugin(`enviar: ignorado (cancelado=${cancelado} cerrado=${cerrado})`)
            return
          }
          pausarAutoEnvio()
          pararCuenta("enviar")
          const composer =
            ctx.sessions.current()?.id === session.id ? ctx.screen.current()?.composer : undefined
          const limpio = (composer?.text() ?? texto()).trim()
          if (!limpio) return
          setDictado("libre")
          cerrarDialogo(false)
          // El borrador ya viaja dentro de `limpio`. OpenCode no vacía el cuadro
          // cuando mandamos por RPC, así que lo limpiamos nosotros (antes se
          // restauraba el borrador y el texto quedaba abajo para siempre).
          if (composer) composer.setText("")
          textoBaseVista = undefined
          const marcado = vozEstado(session.server, session.directory)
          void (async () => {
            try {
              await Promise.race([
                Promise.all([
                  avisarDictado(false),
                  marcado.rpc.marcarDictado({}, marcado.opts).catch(() => {}),
                ]),
                new Promise((r) => setTimeout(r, 250)),
              ])
              await session.server.client.session.prompt({ sessionID: session.id, text: limpio })
              void vozSonido(session.server).sonidoEnvio({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              ctx.toast.show({ title: "Error al enviar el dictado", description: msg, variant: "error" })
            }
          })()
        }

        const iniciarAutoEnvio = () => {
          if (intervaloEnvio) clearInterval(intervaloEnvio)
          setRestante(esperaSeg())
          intervaloEnvio = setInterval(() => {
            const actual = restante()
            if (actual === null) {
              pausarAutoEnvio()
              return
            }
            if (actual <= 1) {
              enviar()
              return
            }
            setRestante(actual - 1)
          }, 1000)
        }

        const cancelar = () => {
          cancelado = true
          cortePorSilencio = false
          setGrabacionPausada(false)
          pausarAutoEnvio()
          // Cancelar frena el dictado pero NO toca el compositor: lo que haya
          // abajo (incluida la vista previa) se conserva para editar y mandar.
          const composerCancelado =
            ctx.sessions.current()?.id === session.id ? ctx.screen.current()?.composer : undefined
          diagPlugin(`cancelar: texto conservado chars=${composerCancelado?.text().length ?? -1}`)
          textoBaseVista = undefined
          vistaPreviaTexto = ""
          detenerVad()
          try {
            if (grabadora && grabadora.state !== "inactive") grabadora.stop()
          } catch {
            // ignora si ya frenó
          }
          detenerTranscripcionParcial()
          fragmentos = []
          liberarMic()
          setDictado("libre")
          cerrarDialogo()
        }

        const alternarPausaGrabacion = () => {
          if (fase() !== "grabando" || !grabadora) return
          try {
            if (!grabacionPausada()) {
              if (grabadora.state === "recording") grabadora.pause()
              if (timerGrabacion) {
                clearInterval(timerGrabacion)
                timerGrabacion = undefined
              }
              setGrabacionPausada(true)
            } else {
              if (grabadora.state === "paused") grabadora.resume()
              if (!timerGrabacion) {
                timerGrabacion = setInterval(() => setSegundos((s) => s + 1), 1000)
              }
              setGrabacionPausada(false)
            }
          } catch {
            // ignora si MediaRecorder no admite pausa en este entorno
          }
        }

        const detenerYTranscribir = () => {
          if (fase() !== "grabando") return
          cortePorSilencio = false
          setGrabacionPausada(false)
          detenerVad()
          try {
            if (grabadora && grabadora.state !== "inactive") {
              sonarFinAlParar = true
              grabadora.stop()
            } else {
              cancelar()
            }
          } catch {
            cancelar()
          }
        }

        detenerActivo = detenerYTranscribir

        const alEnfocarComposer = (e: FocusEvent) => {
          if (dictado() !== "confirmar") return
          if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
            // Poner el cursor para editar también cancela el envío automático.
            controlDictado()?.cancelarEnvio()
          }
        }
        window.addEventListener("focusin", alEnfocarComposer, true)

        const onWindowKeyDown = (e: KeyboardEvent) => {
          if (dictado() === "confirmar") {
            const mover =
              e.key === "ArrowLeft" ||
              e.key === "ArrowRight" ||
              e.key === "ArrowUp" ||
              e.key === "ArrowDown" ||
              e.key === "Home" ||
              e.key === "End"
            if (mover && !e.metaKey && !e.ctrlKey) controlDictado()?.cancelarEnvio()
            return
          }
          if (fase() !== "grabando") return
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            const target = e.target
            if (
              target instanceof HTMLButtonElement &&
              (target.textContent?.includes("Cancelar") ||
                target.textContent?.includes("Pausar") ||
                target.textContent?.includes("Reanudar"))
            ) {
              return
            }
            e.preventDefault()
            e.stopPropagation()
            detenerYTranscribir()
          }
        }
        window.addEventListener("keydown", onWindowKeyDown, true)

        /**
         * El último tramo ya fue transcripto por transcribirTramo: acá solo
         * mandamos el acumulado, sin volver a pedirle audio al proveedor.
         */
        const enviarAcumulado = () => {
          if (cancelado || cerrado) return
          const crudo = textoParcialAcumulado.trim()
          const limpio = autoMic() ? quitarComandoDeEscuchar(crudo) : crudo
          if (!autoMic() && esComandoDejarDeEscuchar(crudo)) {
            void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            desactivarAutoMic()
            setDictado("libre")
            cerrarDialogo()
            ctx.toast.show({ title: "Charla contínua desactivada", variant: "default" })
            return
          }
          if (!limpio) {
            void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            setDictado("libre")
            cerrarDialogo()
            ctx.toast.show({ title: "No se escuchó texto para enviar", variant: "default" })
            return
          }
          textoPegado = ""
          textoVisto = false
          textoDestinoId = ""
          cancelarTimerTextoVacio()
          setTexto(limpio)
          setFase("confirmar")
          setDictado("confirmar")
          ponerTextoEnCompositor(limpio, session)
          iniciarCuenta()
        }

        /**
         * Arma un MediaRecorder para UN tramo. Al silencio se frena, se transcribe
         * ese audio una sola vez y se arma otro distinto sobre el mismo micrófono.
         */
        const crearGrabadora = () => {
          if (cancelado || cerrado || !flujoMic) return
          const inicioTramoMs = performance.now()
          mimeGrabacion =
            ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? ""
          const recorder = mimeGrabacion
            ? new MediaRecorder(flujoMic, { mimeType: mimeGrabacion })
            : new MediaRecorder(flujoMic)
          grabadora = recorder
          fragmentos = []
          vozEnTramo = false

          recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) fragmentos.push(ev.data)
          }

          recorder.onstop = async () => {
            const mimeFinal = recorder.mimeType || mimeGrabacion || "audio/webm"
            const blob = new Blob(fragmentos, { type: mimeFinal })
            const duracionMs = performance.now() - inicioTramoMs
            fragmentos = []

            if (cancelado || cerrado) {
              setDictado("libre")
              return
            }

            if (cortePorSilencio) {
              cortePorSilencio = false
              const conVoz = vozEnTramo
              // Feedback sonoro del corte. Se espera a que termine de sonar para
              // que el proximo recorder no lo grabe como voz del siguiente tramo.
              diagPlugin("corte: tocando beep suave")
              await vozSonido(session.server).sonidoCorteTramo({}, opcionesSonido(session.server, session.directory)).catch(() => {})
              // Sigue escuchando: nuevo recorder, audio nuevo, sin reenviar el viejo.
              crearGrabadora()
              if (!conVoz) {
                // Silencio puro: Groq lo transcribe como "Gracias." inventado.
                diagPlugin(`tramo sin voz descartado dur=${Math.round(duracionMs)}ms bytes=${blob.size}`)
                return
              }
              if (duracionMs < TRAMO_MIN_MS) {
                // Audio demasiado corto: tampoco vale la pena mandarlo.
                diagPlugin(`tramo corto descartado dur=${Math.round(duracionMs)}ms bytes=${blob.size}`)
                return
              }
              void transcribirTramo(blob, mimeFinal).then(procesarFrase)
              return
            }

            // Paro manual / Enter: este es el último tramo.
            detenerVad()
            detenerTranscripcionParcial()
            liberarMic()
            if (sonarFinAlParar) {
              sonarFinAlParar = false
              void vozSonido(session.server).sonidoFinGrabacion({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            }
            if (omitirTranscripcionFinal) {
              omitirTranscripcionFinal = false
              return
            }
            if (!audioUtil()) {
              diagPlugin(`sin voz al parar: audioUtil=false bytes=${blob.size}`)
              void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
              setDictado("libre")
              cerrarDialogo()
              ctx.toast.show({ title: "No se escuchó texto para enviar", variant: "default" })
              return
            }
            if (!vozEnTramo || duracionMs < TRAMO_MIN_MS) {
              // Silencio o audio corto: se descarta y se manda lo acumulado.
              diagPlugin(`tramo final descartado dur=${Math.round(duracionMs)}ms bytes=${blob.size} voz=${vozEnTramo}`)
              enviarAcumulado()
              return
            }
            void transcribirTramo(blob, mimeFinal).then(enviarAcumulado)
          }

          recorder.start(STT_TROZO_MS)
        }

        onMount(() => {
          void (async () => {
            try {
              flujoMic = streamListo
              fragmentos = []
              await Promise.race([
                vozSonido(session.server).sonidoInicioDictado({}, opcionesSonido(session.server, session.directory)).catch(() => {}),
                new Promise((r) => setTimeout(r, 900)),
              ])
              if (cancelado || cerrado) {
                liberarMic()
                return
              }
              crearGrabadora()
              // Sin timer de transcripción: hablamos todo lo que queramos y el
              // STT se llama recién cuando el VAD marca silencio (revisarFrasePorSilencio).
              detenerContador()
              timerGrabacion = setInterval(() => setSegundos((s) => s + 1), 1000)
              setDictado("grabando")
              setFase("grabando")
              iniciarVad(streamListo)
            } catch (error) {
              for (const pista of streamListo.getTracks()) pista.stop()
              detenerTranscripcionParcial()
              detenerVad()
              liberarMic()
              setDictado("libre")
              cerrarDialogo()
              if (!cancelado) {
                const msg = error instanceof Error ? error.message : String(error)
                ctx.toast.show({
                  title: "No se pudo abrir el micrófono",
                  description: msg,
                  variant: "error",
                })
              }
            }
          })()
        })

        onCleanup(() => {
          restaurarTransparencia()
          window.removeEventListener("keydown", onWindowKeyDown, true)
          window.removeEventListener("focusin", alEnfocarComposer, true)
          cancelarTimerTextoVacio()
          detenerVad()
          detenerTranscripcionParcial()
          if (intervaloEnvio) {
            clearInterval(intervaloEnvio)
            intervaloEnvio = undefined
          }
          if (!cerrado) {
            cancelado = true
            cerrado = true
            dialogoAbierto = false
            detenerActivo = undefined
            void avisarDictado(false)
            try {
              if (grabadora && grabadora.state !== "inactive") grabadora.stop()
            } catch {
              // ignora
            }
            detenerTranscripcionParcial()
            textoParcialAcumulado = ""
            textoParcialUltimo = ""
            fragmentos = []
            liberarMic()
            setDictado("libre")
            enfocarCuadroTexto()
          }
        })

        const modificadoras = new Set(["Shift", "Control", "Alt", "Meta", "Tab", "CapsLock"])

        const titulo = () => {
          const f = fase()
          if (f === "abriendo") return "Abriendo micrófono…"
          if (f === "grabando") {
            if (grabacionPausada()) return "Grabación pausada"
            return autoMic() ? "Escuchando (Charla contínua)" : "Grabando dictado"
          }
          if (f === "transcribiendo") return "Transcribiendo…"
          if (f === "error") return "Error al transcribir"
          return "Confirmar dictado"
        }

        const descripcion = () => {
          const f = fase()
          if (f === "abriendo") return "Esperando acceso al micrófono."
          if (f === "grabando") {
            if (grabacionPausada()) {
              return "Grabación en pausa. Tocá Reanudar para seguir dictando o Detener y transcribir para enviar."
            }
            return autoMic()
              ? "Charla contínua activa: se cierra solo en 8 segundos si no hablás. Enter detiene ya, Escape cancela."
              : "Se cierra solo en 8 segundos si no hablás. Enter detiene ya, Escape cancela."
          }
          if (f === "transcribiendo") return "Procesando tu audio…"
          if (f === "error") return "No se pudo transcribir el audio. Podés copiar el detalle o cerrar con Escape."
          return restante() !== null
            ? "Se envía solo al llegar a cero. Enter envía ya, Escape cancela, o mové el cursor para editar."
            : "Envío automático pausado. Enter envía, Shift+Enter baja de renglón, Escape cancela."
        }

        // Cuenta corta para la pill de nivel: tiempo hasta que el silencio dispara el envío.
        const cuentaSilencio = () => {
          if (grabacionPausada()) return "pausa"
          const ev = estadoVoz()
          if (ev === "esperando") {
            const faltan = Math.max(1, Math.ceil((AUTO_MIC_SIN_VOZ_MS - esperaSinVozMs()) / 1000))
            return `cierra en ${faltan}s`
          }
          if (ev === "hablando") return ""
          const faltan = Math.max(1, Math.ceil((pacienciaMs() - silencioMs()) / 1000))
          return `envío en ${faltan}s`
        }

        const textoEstadoVoz = () => {
          if (grabacionPausada()) return "En pausa"
          const ev = estadoVoz()
          if (ev === "esperando") {
            const faltan = Math.max(1, Math.ceil((AUTO_MIC_SIN_VOZ_MS - esperaSinVozMs()) / 1000))
            return `Esperando tu voz… (cierra en ${faltan}s)`
          }
          if (ev === "hablando") return `Escuchando… (corta tras ${esperaTexto()} de silencio)`
          const faltan = Math.max(1, Math.ceil((pacienciaMs() - silencioMs()) / 1000))
          return `Silencio… corta en ${faltan}s`
        }

        const esperaTexto = () => (esperaSeg() === 1 ? "1 segundo" : `${esperaSeg()} segundos`)

        const subirEspera = () => {
          const valor = Math.min(ESPERA_MAX_SEG, esperaSeg() + 1)
          setEsperaSeg(valor)
          guardarEsperaSeg(valor)
        }

        const bajarEspera = () => {
          const valor = Math.max(ESPERA_MIN_SEG, esperaSeg() - 1)
          setEsperaSeg(valor)
          guardarEsperaSeg(valor)
        }

        setControlDictado({
          detener: detenerYTranscribir,
          cancelar,
          pausar: alternarPausaGrabacion,
          cancelarEnvio: () => {
            pausarAutoEnvio()
            setRestante(null)
            pararCuenta("cancelar envío")
          },
          // Cancela solo el envío automático: deja el texto transcripto en el compositor
          // para que el usuario lo edite y lo mande cuando quiera.
          cancelarConservandoTexto: () => {
            pausarAutoEnvio()
            setRestante(null)
            pararCuenta("cancelar envío (conserva texto)")
            cancelarTimerTextoVacio()
            setDictado("libre")
            cerrarDialogo()
          },
          enviarAhora: () => enviar(),
          cerrar: () => {
            setDictado("libre")
            cerrarDialogo()
          },
          nivel: () => nivelMic(),
          segundos: () => segundos(),
          cuentaSilencio: () => cuentaSilencio(),
          audioUtil: () => audioUtil(),
          pausada: () => grabacionPausada(),
          restante: () => cuentaRestante(),
        })

        return <div class="opencode-voz-dictado" style={{ display: "none" }} />
      })
        })
      })()
    }

    const alternarDictado = () => {
      if (apagada()) return
      if (dialogoAbierto) {
        if (dictado() === "grabando") detenerActivo?.()
        return
      }
      abrirDictado()
    }

    ctx.add(ComposerPill, {
      id: "voz-on-off",
      order: 5,
      show: (input): ComposerPillView | undefined => {
        if (dictado() !== "libre" || !apagada()) return undefined
        return {
          label: "PLUGIN VOZ",
          icon: "circle-ban-sign",
          tone: "warning",
          title: "Plugin de voz apagado en esta sesión: sin lectura ni micrófono. Clic para prenderlo",
          run: () => {
            soltarFocoBoton()
            void alternarApagada(input.session.directory)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "voz",
      order: 15,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const actual = estado()
        if (actual.hablando && actual.pausado) {
          return {
            label: "Seguir voz",
            icon: "outline-audio",
            tone: "danger",
            title: "Seguir la lectura desde donde quedó",
            run: () => {
              soltarFocoBoton()
              void pausar(input.session.directory)
              enfocarCuadroTexto()
            },
          }
        }
        if (actual.hablando && actual.enCola && !actual.pausado) {
          return {
            label: "En cola",
            icon: "outline-dots",
            tone: "warning",
            title: "Audio esperando para sonar: arranca apenas esté libre el turno. Stop lo cancela",
          }
        }
        if (actual.hablando && actual.sintetizando && !actual.reproduciendo && !actual.pausado) {
          return {
            label: "Sintetizando...",
            icon: "outline-rotate-clockwise",
            tone: "warning",
            title: "Generando el audio de la respuesta: pasa a Pausar voz apenas empiece a sonar",
          }
        }
        if (actual.hablando) {
          return {
            label: "Pausar voz",
            icon: pulsoVoz() ? "waveform" : "outline-wave-audio",
            tone: "success",
            title: "Pausar la lectura en voz alta",
            run: () => {
              soltarFocoBoton()
              void pausar(input.session.directory)
              enfocarCuadroTexto()
            },
          }
        }
        if (actual.silenciado) {
          return {
            label: "Voz apagada",
            icon: "circle-ban-sign",
            title: "Volver a activar la lectura en voz alta",
            run: () => {
              soltarFocoBoton()
              void alternar(input.session.directory)
              enfocarCuadroTexto()
            },
          }
        }
        if (sesionesSinVoz().has(input.session.id)) {
          return {
            label: "Escuchar",
            icon: "circle-ban-sign",
            title: "No hay voz grabada para repetir en esta sesión",
          }
        }
        return {
          label: "Escuchar",
          icon: "outline-audio",
          title: "Reproducir el audio seleccionado (el más reciente por defecto)",
          run: () => {
            soltarFocoBoton()
            void repetir(input.session.directory, input.session.id)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "detener-voz",
      order: 14,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre" || !estado().hablando) return undefined
        return {
          label: "Stop",
          icon: "stop",
          tone: "danger",
          title: "Cortar la reproducción ahora",
          run: () => {
            soltarFocoBoton()
            cancelarTimerAutoMic()
            void parar(input.session.directory)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "audio-anterior",
      order: 12,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const { actual } = audios()
        // Si no hay adónde ir, la flecha se oculta (como Stop cuando no se reproduce).
        if (actual <= 1) return undefined
        return {
          label: "◀",
          tone: "warning",
          title: "Reproducir la respuesta anterior",
          run: () => {
            soltarFocoBoton()
            moverAudio(input.session.id, input.session.server, input.session.directory, -1)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "audio-siguiente",
      order: 13,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const { actual, total } = audios()
        if (total === 0 || actual >= total) return undefined
        return {
          label: "▶",
          tone: "warning",
          title: "Reproducir la respuesta siguiente",
          run: () => {
            soltarFocoBoton()
            moverAudio(input.session.id, input.session.server, input.session.directory, 1)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictar",
      order: 22,
      show: (): ComposerPillView | undefined => {
        if (apagada()) return undefined
        const actual = dictado()
        if (actual === "grabando") {
          return {
            label: `Enviar voz ${formatoSegundos(segundos())}`,
            icon: "stop",
            tone: "danger",
            title: "Frenar la grabación y enviar el mensaje",
            run: () => controlDictado()?.detener(),
          }
        }
        if (actual === "transcribiendo") {
          return {
            label: "Enviar",
            icon: "outline-audio",
            tone: "warning",
            title: "Transcribiendo el audio: se habilita para enviar cuando termine",
          }
        }
        if (actual === "confirmar") {
          const restante = cuentaRestante()
          if (restante === null || restante === undefined) {
            return {
              label: "Enviar ahora",
              icon: "outline-audio",
              tone: "success",
              title: "Enviar el texto que dejaste en el compositor",
              run: () => controlDictado()?.enviarAhora(),
            }
          }
          return {
            label: `Enviar en ${restante}s`,
            icon: "outline-audio",
            tone: "warning",
            title: "Tocá para cancelar el envío automático y editar el texto",
            run: () => controlDictado()?.cancelarEnvio(),
          }
        }
        return {
          label: "Dictar",
          icon: ctx.icons.grabar,
          tone: "danger",
          title: "Grabar mensaje de voz y enviarlo",
          run: alternarDictado,
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-nivel",
      order: 24,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "grabando") return undefined
        const nivel = controlDictado()?.nivel() ?? 0
        const encendidos = Math.max(0, Math.min(8, Math.round((nivel / 100) * 8)))
        const barra = "█".repeat(encendidos) + "░".repeat(8 - encendidos)
        const cuenta = controlDictado()?.cuentaSilencio() ?? ""
        return {
          label: `${barra}${cuenta ? ` ${cuenta}` : ""}`,
          icon: "outline-wave-audio",
          title: "Nivel del micrófono y cuenta para el envío automático por silencio",
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-pausa",
      order: 20,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "grabando") return undefined
        const pausada = controlDictado()?.pausada() === true
        return {
          label: pausada ? "Reanudar" : "Pausar",
          icon: pausada ? "fill-triangle-down" : ctx.icons.pausa,
          title: pausada ? "Seguir grabando" : "Pausar la grabación",
          run: () => controlDictado()?.pausar(),
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-cancelar",
      order: 21,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "grabando") return undefined
        return {
          label: "Cancelar",
          icon: "circle-xmark",
          title: "Frenar el dictado y conservar el texto del compositor para editarlo",
          run: () => controlDictado()?.cancelar(),
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-cancelar-envio",
      order: 23,
      show: (): ComposerPillView | undefined => {
        const faseActual = dictado()
        if (faseActual !== "confirmar" && faseActual !== "transcribiendo") return undefined
        return {
          label: "Cancelar",
          icon: "circle-xmark",
          title:
            faseActual === "confirmar"
              ? "Cancelar el envío automático y conservar el texto para editarlo"
              : "Frenar el dictado y conservar el texto del compositor para editarlo",
          run: () =>
            faseActual === "confirmar"
              ? controlDictado()?.cancelarConservandoTexto()
              : controlDictado()?.cancelar(),
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-transcribiendo",
      order: 24,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "transcribiendo") return undefined
        return {
          label: "Transcribiendo…",
          icon: "outline-wave-audio",
          tone: "warning",
          title: "Transcribiendo el audio",
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-led",
      order: 23,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "grabando") return undefined
        const util = controlDictado()?.audioUtil() === true
        return {
          label: "Audio",
          icon: util ? "circle-check" : "circle-ban-sign",
          tone: util ? "success" : "danger",
          title: util
            ? "Ya hay audio utilizable para transcribir"
            : "Todavía no hay audio utilizable para transcribir",
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "ajustes-voz",
      order: 30,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const server = input.session.server
        const directory = input.session.directory
        const actual = estado()
        const esMasc = actual.genero === "masc"
        const motor = actual.motor ?? "auto"
        const motorTexto = motor === "elevenlabs" ? "ElevenLabs" : motor === "groq" ? "Groq" : "Auto"
        const ecoActivo = actual.eco !== false
        const cambiar = (fn: (dir?: string, srv?: Servidor) => Promise<void>) => () => {
          soltarFocoBoton()
          void fn(directory, server)
          enfocarCuadroTexto()
        }
        return {
          label: "Ajustes",
          icon: "settings-gear",
          title: "Ajustes de voz: encender/apagar, Charla contínua, género, motor de lectura, motor de dictado, eco y espera del envío",
          rows: [
            {
              id: "voz-on-off",
              label: "VOZ PLUGIN",
              icon: "outline-audio",
              tone: "success",
              detail: "on",
              run: cambiar(alternarApagada),
            },
            {
              id: "auto-mic",
              label: "Charla contínua",
              icon: "outline-wave-audio",
              tone: autoMic() ? "success" : undefined,
              detail: autoMic() ? "on" : "off",
              run: alternarAutoMic,
            },
            {
              id: "genero",
              label: "Género de Voz",
              icon: "outline-audio",
              detail: actual.vozTts ?? (esMasc ? "masculina" : "femenina"),
              run: cambiar(cambiarGenero),
            },
            {
              id: "motor-voz",
              label: "Motor de lectura",
              icon: "outline-audio",
              detail: actual.motorVoz === "edge" ? "Edge" : "macOS",
              run: cambiar(cambiarMotorVoz),
            },
            {
              id: "motor",
              label: "Motor de dictado",
              icon: "outline-audio",
              detail: motorTexto,
              run: cambiar(cambiarMotor),
            },
            {
              id: "eco",
              label: "Eco",
              icon: ecoActivo ? "outline-audio" : "circle-ban-sign",
              tone: ecoActivo ? "success" : undefined,
              detail: ecoActivo ? "prendido" : "apagado",
              run: cambiar(alternarEco),
            },
            {
              id: "espera",
              label: "Espera para enviar",
              icon: "enter",
              detail: `${leerEsperaSeg()} s`,
              run: () => {
                const valores = [2, 3, 5, 10, 20]
                const actualSeg = leerEsperaSeg()
                const indice = valores.indexOf(actualSeg)
                guardarEsperaSeg(valores[(indice + 1) % valores.length] ?? 5)
              },
            },
            {
              id: "hilos",
              label: "Audio entre hilos",
              icon: "outline-wave-audio",
              detail: actual.concurrencia === "esperar" ? "esperar turno" : "cortar anterior",
              run: () => {
                soltarFocoBoton()
                void alternarConcurrencia(directory, server)
                enfocarCuadroTexto()
              },
            },
            {
              id: "corregir",
              label: "Corregir vocabulario",
              icon: "edit",
              run: abrirDialogoVocabulario,
            },
          ],
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "auto-mic-pill",
      order: 31,
      show: (): ComposerPillView | undefined => {
        // Prendido: a la derecha de Ajustes. Apagado: sigue solo dentro del menú.
        if (apagada() || dictado() !== "libre" || !autoMic()) return undefined
        return {
          label: "Charla contínua",
          icon: "outline-wave-audio",
          tone: "success",
          title: "Charla contínua prendida: el micrófono se abre solo tras cada respuesta. Clic para apagarla",
          run: () => {
            alternarAutoMic()
          },
        }
      },
    })

    ctx.add(Command, () => ({
      id: "corregir",
      title: "Vocabulario de voz (/corregir)",
      description: "Usa /corregir palabra para guardar o /corregir lista para ver el vocabulario",
      slash: {
        name: "corregir",
        arguments: true,
      },
      run: (input) => {
        const limpio = (input ?? "").trim()
        if (!limpio || limpio.toLowerCase() === "lista") {
          abrirDialogoVocabulario()
          return
        }
        void guardarTerminoVocabulario(limpio)
      },
    }))

    ctx.add(Command, () => ({
      id: "cortar",
      title: "Cortar audio de otro hilo (/cortar)",
      description: "Alterna entre cortar la lectura anterior o esperar turno cuando otro hilo responde",
      slash: {
        name: "cortar",
      },
      run: () => {
        void alternarConcurrencia()
      },
    }))

    ctx.add(Command, () => ({
      id: "cambiar-genero",
      title: "Cambiar voz femenina o masculina",
      description: "Alterna la lectura entre voz femenina (Dalia) y voz masculina (Carlos)",
      run: () => {
        void cambiarGenero()
      },
    }))

    ctx.add(Command, () => ({
      id: "auto-mic",
      title: "Activar o desactivar Charla contínua",
      description: "Prende o apaga la apertura automática del micrófono tras cada respuesta dictada",
      run: () => {
        alternarAutoMic()
      },
    }))

    ctx.add(Command, () => ({
      id: "dictar",
      title: "Dictar mensaje por voz",
      description: "Graba tu voz y manda el mensaje directo al asistente",
      run: () => {
        alternarDictado()
      },
    }))

    ctx.add(Command, () => ({
      id: "pausar",
      title: "Pausar o seguir la voz",
      description: "Pausa el audio o lo retoma desde donde quedó",
      run: () => {
        void pausar()
      },
    }))

    ctx.add(Command, () => ({
      id: "repetir",
      title: "Repetir el último mensaje",
      description: "Vuelve a leer en voz alta la última respuesta",
      run: () => {
        void repetir()
      },
    }))

    ctx.add(Command, () => ({
      id: "detener",
      title: "Detener la voz",
      description: "Corta el audio que está leyendo el asistente",
      run: () => {
        void parar()
      },
    }))

    ctx.add(Command, () => ({
      id: "silenciar",
      title: "Silenciar o activar la voz",
      description: "Apaga o vuelve a prender la lectura en voz alta",
      run: () => {
        void alternar()
      },
    }))

    let bajas: Array<() => void> = []
    let controlEventosRemotos: AbortController | undefined
    const ultimoTextoPorSesion = new Map<string, { msgID: string; texto: string }>()
    let ultimaSesionLeida: string | undefined
    const cerrarBajas = () => {
      for (const baja of bajas) {
        try {
          baja()
        } catch {
          // ignora
        }
      }
      bajas = []
    }

    /** Consulta al servidor dueño de la sesión si sigue trabajando (session.active). */
    const sesionTrabajando = async (id: string, server?: Servidor): Promise<boolean> => {
      try {
        const activas = await (server?.client ?? ctx.client).session.active()
        return activas[id]?.type === "running"
      } catch (error) {
        diagPlugin(
          `autoMic: no se pudo consultar session.active: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      }
    }

    /** Programa la reapertura del micrófono tras un turno leído en voz alta. */
    const programarAutoMic = (idEvento?: string, dirEvento?: string, origen = "turno") => {
      const txt = (motivo: string) => `autoMic[${origen}]: ${motivo}`
      if (desmontado) return diagPlugin(txt("desmontado"))
      if (!autoMic()) return diagPlugin(txt("off"))
      if (dialogoAbierto || dictado() !== "libre") return diagPlugin(txt(`ocupado=${dictado()}`))
      if (usuarioEscribiendo()) return diagPlugin(txt("escribiendo"))
      const actual = ctx.sessions.current()
      const sesionOrigen = idEvento ? ctx.sessions.list().find((s) => s.id === idEvento) : undefined
      const destinoId = idEvento ?? actual?.id
      const destinoDir = dirEvento ?? sesionOrigen?.location?.directory ?? actual?.directory
      const destinoServer = sesionOrigen?.server ?? actual?.server
      if (!destinoId || !destinoDir || !destinoServer) {
        return diagPlugin(txt(`sin destino id=${destinoId ?? "-"} dir=${destinoDir ?? "-"} srv=${Boolean(destinoServer)}`))
      }
      if (apagada() && actual?.id === destinoId) return diagPlugin(txt("sesion apagada"))
      diagPlugin(txt(`programado ${AUTO_MIC_RETRASO_MS}ms sesion=${destinoId}`))
      cancelarTimerAutoMic()
      let reintentos = 0
      const programarIntento = (espera: number) => {
        timerAutoMic = setTimeout(() => {
          timerAutoMic = undefined
          if (desmontado || !autoMic() || dialogoAbierto || dictado() !== "libre") {
            return diagPlugin(txt(`cancelado en timer estado=${dictado()}`))
          }
          if (usuarioEscribiendo()) return diagPlugin(txt("escribiendo en timer"))
          const ahoraActual = ctx.sessions.current()
          if (apagada() && ahoraActual?.id === destinoId) return diagPlugin(txt("sesion apagada en timer"))
          if (estado().hablando || estado().silenciado) {
            return diagPlugin(txt(`hablando=${estado().hablando} silenciado=${estado().silenciado}`))
          }
          void (async () => {
            if (await sesionTrabajando(destinoId, destinoServer)) {
              reintentos += 1
              if (reintentos > 120) return diagPlugin(txt("sesion sigue trabajando, desisto"))
              diagPlugin(txt(`sesion trabajando, reintento ${reintentos} en 1s`))
              programarIntento(1000)
              return
            }
            diagPlugin(txt("abriendo microfono"))
            abrirDictado(true, { id: destinoId, directory: destinoDir, server: destinoServer })
          })()
        }, espera)
      }
      programarIntento(AUTO_MIC_RETRASO_MS)
    }

    // Se suscribe al servidor de la sesión montada: en remoto, el servidor local de la app
    // nunca emite los eventos del plugin y la Charla contínua no se enteraría de los turnos.
    createEffect(() => {
      const server = ctx.sessions.current()?.server
      const cliente = (server?.client ?? ctx.client).rpc(Voz)
      cerrarBajas()
      controlEventosRemotos?.abort()
      controlEventosRemotos = undefined
      if (server && !server.builtin) {
        const ctrl = new AbortController()
        controlEventosRemotos = ctrl
        const diag = (mensaje: string) =>
          void ctx.client.rpc(Voz).logDiagnostico({ mensaje }).catch(() => {})
        diag(`suscripto a ${server.url}`)
        void (async () => {
          try {
            for await (const ev of server.client.event.subscribe({
              types: ["session.text.ended"],
              signal: ctrl.signal,
            })) {
              if (ctrl.signal.aborted || desmontado) break
              const d = ev.data as { sessionID?: string; assistantMessageID?: string; text?: string }
              const idMontado = ctx.sessions.current()?.id
              diag(
                `evento ${ev.type} sesion=${d?.sessionID ?? "?"} msg=${d?.assistantMessageID ?? "?"} montada=${idMontado ?? "?"} chars=${d?.text?.length ?? 0}`,
              )
              if (!d?.sessionID || !d.text?.trim()) continue
              const previo = ultimoTextoPorSesion.get(d.sessionID)
              if (previo && previo.msgID && previo.msgID === d.assistantMessageID) {
                previo.texto += `\n${d.text}`
              } else {
                ultimoTextoPorSesion.set(d.sessionID, {
                  msgID: d.assistantMessageID ?? "",
                  texto: d.text,
                })
              }
              if (idMontado && d.sessionID !== idMontado) continue
              if (dictado() !== "libre" || apagada()) {
                diag("omitido: dictando o apagada")
                continue
              }
              diag("llamando leerTexto local")
              try {
                await ctx.client
                  .rpc(Voz)
                  .leerTexto({ texto: d.text, sessionID: d.sessionID, msgId: d.assistantMessageID })
                ultimaSesionLeida = d.sessionID
                diag("leerTexto ok")
              } catch (error) {
                diag(`leerTexto error: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } catch (error) {
            diag(`stream cortado: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
      }
      if (server && !server.builtin) {
        bajas.push(
          ctx.client.rpc(Voz).events.on("estado", (evento) => setEstado(evento.data as Estado)),
        )
        // En remoto el plugin local lee en voz alta pero nunca ve los eventos del
        // servidor ajeno, así que no emite "turnoTerminado". Usamos "lecturaTerminada",
        // que sí dispara al terminar la cola de audio en esta máquina.
        diagPlugin("suscripto a lecturaTerminada local")
        bajas.push(
          ctx.client.rpc(Voz).events.on("lecturaTerminada", (evento) => {
            const id = ((evento.data ?? {}) as { sessionID?: string }).sessionID
            if (!ultimaSesionLeida || !id || id !== ultimaSesionLeida) {
              return diagPlugin(
                `lecturaTerminada ignorada sesion=${id ?? "?"} esperada=${ultimaSesionLeida ?? "?"}`,
              )
            }
            diagPlugin(`lecturaTerminada local sesion=${id} autoMic=${autoMic()}`)
            programarAutoMic(id, undefined, "lecturaTerminada")
          }),
        )
      }
      try {
        if (!server?.builtin) {
          bajas.push(
            cliente.events.on("textoParaLeer", (evento) => {
              if (desmontado || dictado() !== "libre") return
              const dir = carpetaActual()
              if (dir && evento.location?.directory && evento.location.directory !== dir) return
              const data = (evento.data ?? {}) as { texto?: string; sessionID?: string }
              if (!data.texto?.trim()) return
              void ctx.client
                .rpc(Voz)
                .leerTexto(data.sessionID ? { texto: data.texto, sessionID: data.sessionID } : { texto: data.texto })
                .catch(() => {})
            }),
          )
        }
        bajas.push(
          cliente.events.on("estado", (evento) => {
            const dir = carpetaActual()
            if (dir && evento.location?.directory && evento.location.directory !== dir) return
            setEstado(evento.data as Estado)
          }),
        )
        bajas.push(
          cliente.events.on("turnoTerminado", (evento) => {
            const data = (evento.data ?? {}) as { sessionID?: string }
            programarAutoMic(data.sessionID, evento.location?.directory, "turnoTerminado")
          }),
        )
      } catch {
        // si falla la suscripción, el sondeo mantiene el botón al día
      }
    })
    onCleanup(cerrarBajas)

    createEffect(() => {
      const dir = carpetaActual()
      if (dir) void refrescar(dir)
    })

    createEffect(() => {
      const id = ctx.sessions.current()?.id
      if (id) void refrescarApagada()
    })

    // Consulta al plugin local si quedó voz para repetir al cambiar de sesión
    // y al arrancar/terminar una lectura.
    createEffect(() => {
      const sesion = ctx.sessions.current()
      void estado().hablando
      if (sesion?.id) {
        void refrescarVozDisponible(sesion.id, sesion.server, sesion.directory)
        void refrescarAudios(sesion.id, sesion.server, sesion.directory)
      }
    })

    const sondeo = setInterval(() => {
      void refrescar()
      void refrescarApagada()
    }, 2000)

    return () => {
      desmontado = true
      window.removeEventListener("keydown", onTeclaUsuario, true)
      cancelarTimerTextoVacio()
      pararCuenta("desmontaje")
      cancelarTimerAutoMic()
      liberarMic()
      cerrarBajas()
      controlEventosRemotos?.abort()
      clearInterval(sondeo)
    }
  },
})
