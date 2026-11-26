import { Command, ComposerPill, Plugin, Style, type ComposerPillView } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, getOwner, onCleanup, onMount, runWithOwner } from "solid-js"
import { Voz } from "./rpc.js"

type Estado = {
  hablando: boolean
  pausado: boolean
  silenciado: boolean
  genero?: "fem" | "masc"
  motor?: "auto" | "elevenlabs" | "groq"
  eco?: boolean
  concurrencia?: "cortar" | "esperar"
}
type EstadoDictado = "libre" | "grabando" | "transcribiendo" | "confirmar"
type FasePopup = "abriendo" | "grabando" | "transcribiendo" | "confirmar" | "error"
type EstadoVoz = "esperando" | "hablando" | "pausa"

const VAD_TICK_MS = 100
const VAD_CALIBRACION_TICKS = 10
const VAD_ESTABILIZACION_MS = 250
const VAD_CALIBRACION_RETRASO_MS = 600
const VAD_MIN_VOZ_MS = 200
const VAD_UMBRAL_MIN = 0.006
const VAD_MULTIPLICADOR_RUIDO = 2.1
const AUTO_MIC_STORAGE_KEY = "opencode-voz.autoMic"
const AUTO_MIC_RETRASO_MS = 400
const AUTO_MIC_PAUSA_TECLADO_MS = 4000
const AUTO_MIC_SIN_VOZ_MS = 8000
const AUTO_MIC_ESTABILIZACION_MS = 250
const AUTO_MIC_UMBRAL_MIN = 0.009
const AUTO_MIC_MULTIPLICADOR_RUIDO = 2.1
const AUTO_MIC_MIN_VOZ_MS = 200
const ESPERA_STORAGE_KEY = "opencode-voz.esperaDictado"
const ESPERA_DEFECTO_SEG = 5
const ESPERA_MIN_SEG = 1
const ESPERA_MAX_SEG = 20
const AUDIO_UTIL_MS = 400

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

function esComandoDejarDeEscuchar(texto: string): boolean {
  const normalizado = texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¡!¿?.,;:()[\]"'«»…-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return normalizado === "dejar de escuchar" || normalizado === "deja de escuchar"
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
button[aria-label="Grabar mensaje de voz y enviarlo"],
button[title="Grabar mensaje de voz y enviarlo"] {
  background: transparent !important;
  border-color: #ef4444 !important;
  box-shadow: inset 0 0 0 1px #ef4444 !important;
}
button[aria-label="Grabar mensaje de voz y enviarlo"]:active,
button[title="Grabar mensaje de voz y enviarlo"]:active {
  background: rgba(220, 38, 38, 0.45) !important;
  color: #fecaca !important;
}
button[aria-label="Frenar la grabación y enviar el mensaje"],
button[title="Frenar la grabación y enviar el mensaje"] {
  background: rgba(220, 38, 38, 0.38) !important;
  border-color: #ef4444 !important;
  color: #fecaca !important;
}
`

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
  setup(ctx) {
    const rootOwner = getOwner()
    let desmontado = false
    ctx.add(Style, ESTILOS_DICTADO)

    const [estado, setEstado] = createSignal<Estado>({
      hablando: false,
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

    let grabadora: MediaRecorder | undefined
    let flujoMic: MediaStream | undefined
    let fragmentos: Blob[] = []
    let timerGrabacion: ReturnType<typeof setInterval> | undefined
    let timerAutoMic: ReturnType<typeof setTimeout> | undefined
    let dialogoAbierto = false
    let detenerActivo: (() => void) | undefined
    let ultimaTeclaEn = 0

    const cancelarTimerAutoMic = () => {
      if (timerAutoMic) {
        clearTimeout(timerAutoMic)
        timerAutoMic = undefined
      }
    }

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

    const [apagada, setApagada] = createSignal(false)

    const sesionActual = () => ctx.sessions.current()

    const refrescarApagada = async (directory?: string) => {
      const sesion = sesionActual()
      if (!sesion?.id) {
        setApagada(false)
        return
      }
      try {
        const res = (await voz().estadoSesion({ sessionID: sesion.id }, opciones(directory))) as {
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
        const res = (await voz().alternarApagado({ sessionID: sesion.id }, opciones(directory))) as {
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
      if (!opts) return
      try {
        setEstado((await voz().estado({}, opts)) as Estado)
      } catch {
        // el servidor todavía no está listo; el próximo sondeo lo resuelve
      }
    }

    const pausar = async (directory?: string) => {
      try {
        setEstado((await voz().pausar({}, opciones(directory))) as Estado)
      } catch {
        // si el servidor no contesta, no hay audio que pausar
      }
    }

    const repetir = async (directory?: string, sessionID?: string) => {
      const id = sessionID ?? sesionActual()?.id
      const servidor = sesionActual()?.server
      if (servidor && !servidor.builtin && id) {
        let texto = ultimoTextoPorSesion.get(id)
        if (!texto) {
          try {
            const mensajes = await servidor.client.session.context({ sessionID: id })
            for (let i = mensajes.length - 1; i >= 0; i--) {
              const m = mensajes[i] as {
                type?: string
                content?: Array<{ type?: string; text?: string }>
              }
              if (m?.type !== "assistant") continue
              const partes = (m.content ?? [])
                .filter((p) => p?.type === "text" && p.text?.trim())
                .map((p) => p.text as string)
              if (partes.length) {
                texto = partes.join("\n")
                break
              }
            }
          } catch {
            // sin contexto remoto: no hay nada para repetir
          }
        }
        if (texto?.trim()) {
          await ctx.client.rpc(Voz).leerTexto({ texto, sessionID: id }).catch(() => {})
          return
        }
      }
      try {
        setEstado((await voz().repetir(id ? { sessionID: id } : {}, opciones(directory))) as Estado)
      } catch {
        // si el servidor no contesta, no hay audio que repetir
      }
    }

    const parar = async (directory?: string) => {
      try {
        setEstado((await voz().parar({}, opciones(directory))) as Estado)
      } catch {
        // si el servidor no contesta, no hay audio que cortar
      }
    }

    const alternar = async (directory?: string) => {
      try {
        setEstado((await voz().alternar({}, opciones(directory))) as Estado)
      } catch {
        // ídem
      }
    }

    const cambiarGenero = async (directory?: string) => {
      try {
        setEstado((await voz().cambiarGenero({}, opciones(directory))) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el género
      }
    }

    const cambiarMotor = async (directory?: string) => {
      try {
        setEstado((await voz().cambiarMotor({}, opciones(directory))) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el motor de dictado
      }
    }

    const alternarEco = async (directory?: string) => {
      try {
        setEstado((await voz().alternarEco({}, opciones(directory))) as Estado)
      } catch {
        // si el servidor no contesta, no cambia el eco
      }
    }

    const alternarConcurrencia = async (directory?: string) => {
      try {
        const res = (await voz().alternarConcurrencia({}, opciones(directory))) as Estado
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
        const res = (await voz().agregarVocabulario({ termino }, opciones())) as {
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
                const res = (await voz().listarVocabulario({}, opciones())) as {
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
                    placeholder="Por ejemplo: Auto-mic"
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
      enviarAhora: () => void
      cerrar: () => void
      nivel: () => number
      segundos: () => number
      pausada: () => boolean
      restante: () => number | null
    }
    let controlDictado: ControlDictado | undefined
    let textoPrevio = ""
    let textoPegado = ""
    let textoVisto = false

    const [cuentaRestante, setCuentaRestante] = createSignal<number | null>(null)
    let timerCuenta: ReturnType<typeof setInterval> | undefined
    const pararCuenta = () => {
      if (timerCuenta) {
        clearInterval(timerCuenta)
        timerCuenta = undefined
      }
      setCuentaRestante(null)
    }
    const iniciarCuenta = () => {
      pararCuenta()
      const seg = Math.max(2, leerEsperaSeg())
      setCuentaRestante(seg)
      timerCuenta = setInterval(() => {
        const actual = cuentaRestante()
        if (actual === null) {
          pararCuenta()
          return
        }
        if (actual <= 1) {
          pararCuenta()
          controlDictado?.enviarAhora()
          return
        }
        setCuentaRestante(actual - 1)
      }, 1000)
    }

    const cancelarCuentaEnCompositor = (e: Event) => {
      if (dictado() !== "confirmar" || cuentaRestante() === null) return
      const composer = document.querySelector<HTMLElement>('[data-component="composer"]')
      if (composer && e.target instanceof Node && composer.contains(e.target)) pararCuenta()
    }
    window.addEventListener("pointerdown", cancelarCuentaEnCompositor, true)
    window.addEventListener("keydown", cancelarCuentaEnCompositor, true)

    const ponerTextoEnCompositor = (texto: string, destino: DestinoDictado) => {
      const composer =
        ctx.sessions.current()?.id === destino.id ? ctx.screen.current()?.composer : undefined
      textoPrevio = composer?.text() ?? ""
      textoPegado = texto
      textoVisto = false
      composer?.setText(texto)
    }

    createEffect(() => {
      const actual = ctx.screen.current()?.composer.text()
      if (dictado() !== "confirmar" || actual === undefined || !textoPegado) return
      const limpio = actual.trim()
      if (limpio === textoPegado.trim()) {
        textoVisto = true
        return
      }
      // El setText se aplica en cola: no reaccionamos hasta ver el texto pegado.
      if (!textoVisto) return
      if (limpio === "") {
        controlDictado?.cerrar()
      } else {
        controlDictado?.cancelarEnvio()
      }
    })

    const abrirDictado = (modoAuto = false, destino?: DestinoDictado) => {
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
      const avisarDictado = (activo: boolean) =>
        voz(session.server)
          .estadoDictado({ activo }, opciones(session.directory))
          .then((res) => setEstado(res as Estado))
          .catch(() => {})
      const corteVoz = avisarDictado(true)
      dialogoAbierto = true

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
        const [pacienciaMs, setPacienciaMs] = createSignal(esperaSeg() * 1000)
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
          setPacienciaMs(esperaSeg() * 1000)
          setEstadoVoz("esperando")
        }

        const iniciarVad = (stream: MediaStream) => {
          detenerVad()
          try {
            const w = window as unknown as {
              AudioContext?: typeof AudioContext
              webkitAudioContext?: typeof AudioContext
            }
            const AudioCtx = w.AudioContext ?? w.webkitAudioContext
            if (!AudioCtx) return
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
            let silenceSince: number | null = null

            intervaloVad = setInterval(() => {
              if (cancelado || cerrado || fase() !== "grabando") {
                detenerVad()
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
                if (speechMs >= AUDIO_UTIL_MS) setAudioUtil(true)
                if (!spoke && speechMs >= minVozMs) {
                  spoke = true
                }
                if (spoke) {
                  setEstadoVoz("hablando")
                }
                silenceSince = null
                setSilencioMs(0)
                return
              }

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

              // Paciencia adaptativa: en dictados largos las pausas para pensar son más largas
              const baseEspera = esperaSeg() * 1000
              const paciencia = speechMs > 20000 ? baseEspera + 2000 : speechMs > 9000 ? baseEspera + 1000 : baseEspera
              setPacienciaMs(paciencia)

              if (silenceSince === null) {
                silenceSince = ahora
              }
              const callado = ahora - silenceSince
              setSilencioMs(callado)
              if (callado >= 600) setEstadoVoz("pausa")
              if (callado >= paciencia) {
                detenerVad()
                detenerYTranscribir()
              }
            }, VAD_TICK_MS)

            if (ctxAudio.state === "suspended") {
              void ctxAudio.resume().catch(() => {})
            }
          } catch {
            // Si Web Audio no está disponible, el dictado manual con Enter sigue funcionando.
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
          if (intervaloEnvio) {
            clearInterval(intervaloEnvio)
            intervaloEnvio = undefined
          }
          if (liberarBloqueo) void avisarDictado(false)
          dialog.close()
          enfocarCuadroTexto()
        }

        const enviar = () => {
          if (cancelado || cerrado) return
          pausarAutoEnvio()
          pararCuenta()
          const composer =
            ctx.sessions.current()?.id === session.id ? ctx.screen.current()?.composer : undefined
          const limpio = (composer?.text() ?? texto()).trim()
          if (!limpio) return
          setDictado("libre")
          cerrarDialogo(false)
          if (composer) composer.setText(textoPrevio)
          void (async () => {
            try {
              await Promise.race([
                Promise.all([
                  avisarDictado(false),
                  voz(session.server).marcarDictado({}, opciones(session.directory)).catch(() => {}),
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
          setGrabacionPausada(false)
          pausarAutoEnvio()
          if (dictado() === "confirmar") {
            const composer =
              ctx.sessions.current()?.id === session.id ? ctx.screen.current()?.composer : undefined
            if (composer && composer.text() === textoPegado) composer.setText(textoPrevio)
          }
          detenerVad()
          try {
            if (grabadora && grabadora.state !== "inactive") grabadora.stop()
          } catch {
            // ignora si ya frenó
          }
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
          setGrabacionPausada(false)
          detenerVad()
          try {
            if (grabadora && grabadora.state !== "inactive") {
              grabadora.stop()
              void vozSonido(session.server).sonidoFinGrabacion({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            } else {
              cancelar()
            }
          } catch {
            cancelar()
          }
        }

        detenerActivo = detenerYTranscribir

        const onWindowKeyDown = (e: KeyboardEvent) => {
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

        const transcribirBlob = async (blob: Blob, mimeType: string) => {
          if (cancelado) return
          if (blob.size < 200) {
            void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            setDictado("libre")
            cerrarDialogo()
            ctx.toast.show({ title: "Grabación demasiado corta", variant: "default" })
            return
          }
          setFase("transcribiendo")
          setDictado("transcribiendo")
          try {
            const audioBase64 = await blobABase64(blob)
            if (cancelado) return
            const res = await transcribirDictado(session.server, session.directory, audioBase64, mimeType)
            if (cancelado) return
            if (res.error) {
              void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
              setDictado("libre")
              cerrarDialogo()
              ctx.toast.show({ title: "No se pudo transcribir el audio", description: res.error, variant: "error" })
              return
            }
            const limpio = res.text.trim()
            if (!limpio) {
              void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
              setDictado("libre")
              cerrarDialogo()
              ctx.toast.show({ title: "No se escuchó texto para enviar", variant: "default" })
              return
            }
            if (esComandoDejarDeEscuchar(limpio)) {
              void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
              desactivarAutoMic()
              setDictado("libre")
              cerrarDialogo()
              ctx.toast.show({ title: "Auto-mic desactivado", variant: "default" })
              return
            }
            setTexto(limpio)
            setFase("confirmar")
            setDictado("confirmar")
            ponerTextoEnCompositor(limpio, session)
            iniciarCuenta()
          } catch (error) {
            if (cancelado) return
            void vozSonido(session.server).sonidoSinVoz({}, opcionesSonido(session.server, session.directory)).catch(() => {})
            setDictado("libre")
            const msg = error instanceof Error ? error.message : String(error)
            cerrarDialogo()
            ctx.toast.show({ title: "No se pudo transcribir el audio", description: msg, variant: "error" })
          }
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
              const mime =
                ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ??
                ""
              const recorder = mime ? new MediaRecorder(streamListo, { mimeType: mime }) : new MediaRecorder(streamListo)
              grabadora = recorder

              recorder.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) fragmentos.push(ev.data)
              }

              recorder.onstop = () => {
                const mimeFinal = recorder.mimeType || mime || "audio/webm"
                const blob = new Blob(fragmentos, { type: mimeFinal })
                fragmentos = []
                detenerVad()
                liberarMic()
                if (cancelado || cerrado) {
                  setDictado("libre")
                  return
                }
                void transcribirBlob(blob, mimeFinal)
              }

              recorder.start()
              detenerContador()
              timerGrabacion = setInterval(() => setSegundos((s) => s + 1), 1000)
              setDictado("grabando")
              setFase("grabando")
              iniciarVad(streamListo)
            } catch (error) {
              for (const pista of streamListo.getTracks()) pista.stop()
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
          detenerVad()
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
            return modoAuto ? "Escuchando (Auto-mic)" : "Grabando dictado"
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
            return modoAuto
              ? "Auto-mic activo: se cierra solo en 8 segundos si no hablás. Enter detiene ya, Escape cancela."
              : "Se cierra solo en 8 segundos si no hablás. Enter detiene ya, Escape cancela."
          }
          if (f === "transcribiendo") return "Procesando tu audio…"
          if (f === "error") return "No se pudo transcribir el audio. Podés copiar el detalle o cerrar con Escape."
          return restante() !== null
            ? "Se envía solo al llegar a cero. Enter envía ya, Escape cancela, o mové el cursor para editar."
            : "Envío automático pausado. Enter envía, Shift+Enter baja de renglón, Escape cancela."
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

        controlDictado = {
          detener: detenerYTranscribir,
          cancelar,
          pausar: alternarPausaGrabacion,
          cancelarEnvio: () => {
            pausarAutoEnvio()
            setRestante(null)
            pararCuenta()
          },
          enviarAhora: () => enviar(),
          cerrar: () => {
            setDictado("libre")
            cerrarDialogo()
          },
          nivel: () => nivelMic(),
          segundos: () => segundos(),
          pausada: () => grabacionPausada(),
          restante: () => cuentaRestante(),
        }

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
      show: (input): ComposerPillView => {
        if (dictado() !== "libre") return undefined
        const off = apagada()
        return {
          label: off ? "Voz OFF" : "Voz ON",
          icon: off ? "circle-ban-sign" : "outline-audio",
          tone: off ? "warning" : "success",
          title: off
            ? "Plugin de voz apagado en esta sesión: sin lectura ni micrófono. Clic para prenderlo"
            : "Plugin de voz prendido en esta sesión. Clic para apagarlo del todo",
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
      order: 10,
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
        if (actual.hablando) {
          return {
            label: "Pausar voz",
            icon: "outline-wave-audio",
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
        return {
          label: "Voz",
          icon: "outline-audio",
          title: "Repetir el último mensaje leído",
          run: () => {
            soltarFocoBoton()
            void repetir(input.session.directory, input.session.id)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictar",
      order: 20,
      show: (): ComposerPillView | undefined => {
        if (apagada()) return undefined
        const actual = dictado()
        if (actual === "grabando") {
          return {
            label: `Enviar voz ${formatoSegundos(segundos())}`,
            icon: "stop",
            tone: "danger",
            title: "Frenar la grabación y enviar el mensaje",
            run: () => controlDictado?.detener(),
          }
        }
        if (actual === "transcribiendo") {
          return {
            label: "Transcribiendo…",
            icon: "outline-wave-audio",
            tone: "warning",
            title: "Transcribiendo el audio",
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
              run: () => controlDictado?.enviarAhora(),
            }
          }
          return {
            label: `Enviar en ${restante}s`,
            icon: "outline-audio",
            tone: "warning",
            title: "Tocá para cancelar el envío automático y editar el texto",
            run: () => controlDictado?.cancelarEnvio(),
          }
        }
        return {
          label: "Dictar",
          icon: "outline-wave-audio",
          tone: "danger",
          title: "Grabar mensaje de voz y enviarlo",
          run: alternarDictado,
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-nivel",
      order: 21,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "grabando") return undefined
        const nivel = controlDictado?.nivel() ?? 0
        const encendidos = Math.max(0, Math.min(8, Math.round((nivel / 100) * 8)))
        const barra = "█".repeat(encendidos) + "░".repeat(8 - encendidos)
        return {
          label: `${barra} ${formatoSegundos(controlDictado?.segundos() ?? 0)}`,
          icon: "outline-wave-audio",
          title: "Nivel del micrófono y tiempo de grabación",
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-pausa",
      order: 22,
      show: (): ComposerPillView | undefined => {
        if (dictado() !== "grabando") return undefined
        const pausada = controlDictado?.pausada() === true
        return {
          label: pausada ? "Reanudar" : "Pausar",
          icon: pausada ? "fill-triangle-down" : "dash",
          title: pausada ? "Seguir grabando" : "Pausar la grabación",
          run: () => controlDictado?.pausar(),
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "dictado-cancelar",
      order: 23,
      show: (): ComposerPillView | undefined => {
        const actual = dictado()
        if (actual !== "grabando" && actual !== "confirmar") return undefined
        return {
          label: "Cancelar",
          icon: "circle-xmark",
          title: "Descartar la grabación y volver a los botones normales",
          run: () => controlDictado?.cancelar(),
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "auto-mic",
      order: 30,
      show: (): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        if (autoMic()) {
          return {
            label: "Auto-mic on",
            icon: "outline-wave-audio",
            tone: "success",
            title: "Auto-mic prendido: vuelve a abrir el dictado al terminar cada respuesta dictada",
            run: alternarAutoMic,
          }
        }
        return {
          label: "Auto-mic off",
          icon: "outline-audio",
          title: "Prender Auto-mic para reabrir el dictado automáticamente tras cada respuesta dictada",
          run: alternarAutoMic,
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "genero-voz",
      order: 40,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const esMasc = estado().genero === "masc"
        return {
          label: esMasc ? "Masc" : "Fem",
          icon: "outline-audio",
          tone: esMasc ? "warning" : undefined,
          title: esMasc
            ? "Voz masculina (Carlos): clic para cambiar a voz femenina (Dalia)"
            : "Voz femenina (Dalia): clic para cambiar a voz masculina (Carlos)",
          run: () => {
            soltarFocoBoton()
            void cambiarGenero(input.session.directory)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "motor-dictado",
      order: 50,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const actual = estado().motor ?? "auto"
        const label = actual === "elevenlabs" ? "Eleven" : actual === "groq" ? "Groq" : "Auto"
        const title =
          actual === "auto"
            ? "Dictado automático: ElevenLabs y, si falla, Groq. Clic para usar solo ElevenLabs"
            : actual === "elevenlabs"
              ? "Dictado solo con ElevenLabs. Clic para usar solo Groq"
              : "Dictado solo con Groq. Clic para volver al automático"
        return {
          label,
          icon: "outline-audio",
          tone: actual === "elevenlabs" ? "success" : actual === "groq" ? "warning" : undefined,
          title,
          run: () => {
            soltarFocoBoton()
            void cambiarMotor(input.session.directory)
            enfocarCuadroTexto()
          },
        }
      },
    })

    ctx.add(ComposerPill, {
      id: "eco-voz",
      order: 55,
      show: (input): ComposerPillView | undefined => {
        if (apagada() || dictado() !== "libre") return undefined
        const activo = estado().eco !== false
        return {
          label: "Eco",
          icon: activo ? "outline-audio" : "circle-ban-sign",
          tone: activo ? "success" : undefined,
          title: activo
            ? "Eco prendido: lee tus mensajes, 'Trabajando.' y herramientas. Clic para apagarlo"
            : "Eco apagado: solo lee las respuestas del asistente. Clic para prenderlo",
          run: () => {
            soltarFocoBoton()
            void alternarEco(input.session.directory)
            enfocarCuadroTexto()
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
      title: "Activar o desactivar Auto-mic",
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
    const ultimoTextoPorSesion = new Map<string, string>()
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

    // Se suscribe al servidor de la sesión montada: en remoto, el servidor local de la app
    // nunca emite los eventos del plugin y el Auto-mic no se enteraría de los turnos.
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
              const d = ev.data as { sessionID?: string; text?: string }
              const idMontado = ctx.sessions.current()?.id
              diag(
                `evento ${ev.type} sesion=${d?.sessionID ?? "?"} montada=${idMontado ?? "?"} chars=${d?.text?.length ?? 0}`,
              )
              if (!d?.sessionID || !d.text?.trim()) continue
              ultimoTextoPorSesion.set(d.sessionID, d.text)
              if (idMontado && d.sessionID !== idMontado) continue
              if (dictado() !== "libre" || apagada()) {
                diag("omitido: dictando o apagada")
                continue
              }
              diag("llamando leerTexto local")
              try {
                await ctx.client.rpc(Voz).leerTexto({ texto: d.text, sessionID: d.sessionID })
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
            if (desmontado || !autoMic() || dialogoAbierto || dictado() !== "libre") return
            if (usuarioEscribiendo()) return
            const data = (evento.data ?? {}) as { sessionID?: string }
            const idEvento = data.sessionID
            const dirEvento = evento.location?.directory
            const actual = ctx.sessions.current()
            const sesionOrigen = idEvento ? ctx.sessions.list().find((s) => s.id === idEvento) : undefined
            const destinoId = idEvento ?? actual?.id
            const destinoDir = dirEvento ?? sesionOrigen?.location?.directory ?? actual?.directory
            const destinoServer = sesionOrigen?.server ?? actual?.server
            if (!destinoId || !destinoDir || !destinoServer) return
            if (apagada() && actual?.id === destinoId) return
            cancelarTimerAutoMic()
            timerAutoMic = setTimeout(() => {
              timerAutoMic = undefined
              if (desmontado || !autoMic() || dialogoAbierto || dictado() !== "libre") return
              if (usuarioEscribiendo()) return
              const ahoraActual = ctx.sessions.current()
              if (apagada() && ahoraActual?.id === destinoId) return
              if (estado().hablando || estado().silenciado) return
              abrirDictado(true, { id: destinoId, directory: destinoDir, server: destinoServer })
            }, AUTO_MIC_RETRASO_MS)
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

    const sondeo = setInterval(() => {
      void refrescar()
      void refrescarApagada()
    }, 2000)

    return () => {
      desmontado = true
      window.removeEventListener("keydown", onTeclaUsuario, true)
      window.removeEventListener("pointerdown", cancelarCuentaEnCompositor, true)
      window.removeEventListener("keydown", cancelarCuentaEnCompositor, true)
      pararCuenta()
      cancelarTimerAutoMic()
      liberarMic()
      cerrarBajas()
      controlEventosRemotos?.abort()
      clearInterval(sondeo)
    }
  },
})
