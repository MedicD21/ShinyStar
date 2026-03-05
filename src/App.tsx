/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

declare global {
  interface Window {
    cv?: any
  }
}

type Rect = { x: number; y: number; w: number; h: number }
type Match = Rect & { score: number; scale: number }
type TemplateVariant = { scale: number; mat: any }

const TEMPLATE_SCALES = [0.8, 0.9, 1, 1.1, 1.2]
const MIN_ROI_SIZE = 20
const SCAN_INTERVAL_MS = 110
const REQUIRED_STABLE_MATCHES = 3
const MATCH_POSITION_TOLERANCE_PX = 26
const MATCH_SIZE_TOLERANCE_RATIO = 0.2

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const normalizeRect = (x1: number, y1: number, x2: number, y2: number, canvas: HTMLCanvasElement): Rect => {
  const left = clamp(Math.min(x1, x2), 0, canvas.width)
  const top = clamp(Math.min(y1, y2), 0, canvas.height)
  const right = clamp(Math.max(x1, x2), 0, canvas.width)
  const bottom = clamp(Math.max(y1, y2), 0, canvas.height)

  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  }
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)

  const [threshold, setThreshold] = useState(0.78)
  const [status, setStatus] = useState('Status: Idle')
  const [frameCount, setFrameCount] = useState(0)
  const [score, setScore] = useState(0)
  const [stableHits, setStableHits] = useState(0)

  const roiRef = useRef<Rect | null>(null)
  const detectionsRef = useRef<Rect[]>([])
  const drawingRef = useRef(false)
  const drawingStartRef = useRef({ x: 0, y: 0 })

  const templateVariantsRef = useRef<TemplateVariant[]>([])
  const detectionTimerRef = useRef<number | null>(null)
  const detectionLockedRef = useRef(false)
  const scanInProgressRef = useRef(false)
  const previousCandidateRef = useRef<Rect | null>(null)
  const stableMatchCountRef = useRef(0)

  const openCvReadyPromiseRef = useRef<Promise<void> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const fallbackAudioRef = useRef<HTMLAudioElement | null>(null)
  const alertQueueRef = useRef(Promise.resolve())

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const videoTrackRef = useRef<MediaStreamTrack | null>(null)

  // Performance: avoid drawImage + imread per frame by capturing directly from video.
  const videoCaptureRef = useRef<any>(null)
  const frameMatRef = useRef<any>(null)

  const statsText = useMemo(
    () => `Frames scanned: ${frameCount} | Match score: ${score.toFixed(3)} | Stable hits: ${stableHits}/${REQUIRED_STABLE_MATCHES}`,
    [frameCount, score, stableHits],
  )

  const redrawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const roi = roiRef.current
    if (roi) {
      ctx.strokeStyle = 'yellow'
      ctx.lineWidth = 3
      ctx.strokeRect(roi.x, roi.y, roi.w, roi.h)
    }

    detectionsRef.current.forEach((detection) => {
      ctx.strokeStyle = 'lime'
      ctx.lineWidth = 4
      ctx.strokeRect(detection.x, detection.y, detection.w, detection.h)
    })
  }, [])

  const getCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = overlayRef.current
    if (!canvas) {
      return { x: 0, y: 0 }
    }

    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    return {
      x: clamp(Math.round((clientX - rect.left) * scaleX), 0, canvas.width),
      y: clamp(Math.round((clientY - rect.top) * scaleY), 0, canvas.height),
    }
  }, [])

  const clearCandidateState = useCallback(() => {
    stableMatchCountRef.current = 0
    previousCandidateRef.current = null
    setStableHits(0)
  }, [])

  const clearDetectionLoop = useCallback(() => {
    if (detectionTimerRef.current !== null) {
      window.clearInterval(detectionTimerRef.current)
      detectionTimerRef.current = null
    }
    scanInProgressRef.current = false
  }, [])

  const clearTemplateVariants = useCallback(() => {
    templateVariantsRef.current.forEach((variant) => variant.mat.delete())
    templateVariantsRef.current = []
  }, [])

  const waitForOpenCv = useCallback((timeoutMs = 10000): Promise<void> => {
    if (window.cv && typeof window.cv.Mat === 'function') {
      return Promise.resolve()
    }

    if (!openCvReadyPromiseRef.current) {
      openCvReadyPromiseRef.current = new Promise<void>((resolve, reject) => {
        const startedAt = Date.now()

        const check = () => {
          if (window.cv && typeof window.cv.Mat === 'function') {
            resolve()
            return
          }

          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error('OpenCV failed to load.'))
            return
          }

          window.setTimeout(check, 50)
        }

        check()
      }).catch((error) => {
        openCvReadyPromiseRef.current = null
        throw error
      })
    }

    return openCvReadyPromiseRef.current
  }, [])

  const getAlertAudioContext = useCallback(() => {
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextClass) {
      return null
    }

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContextClass()
    }

    return audioContextRef.current
  }, [])

  const getFallbackAlertAudio = useCallback(() => {
    if (!fallbackAudioRef.current) {
      fallbackAudioRef.current = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg')
      fallbackAudioRef.current.preload = 'auto'
      fallbackAudioRef.current.load()
    }

    return fallbackAudioRef.current
  }, [])

  const primeAlertAudio = useCallback(async () => {
    const context = getAlertAudioContext()

    if (context) {
      if (context.state === 'suspended') {
        await context.resume()
      }

      const source = context.createBufferSource()
      const gain = context.createGain()

      source.buffer = context.createBuffer(1, 1, 22050)
      gain.gain.value = 0.0001

      source.connect(gain)
      gain.connect(context.destination)

      source.start()
      source.stop(context.currentTime + 0.001)
      return
    }

    const fallback = getFallbackAlertAudio()
    const wasMuted = fallback.muted

    try {
      fallback.muted = true
      await fallback.play()
      fallback.pause()
      fallback.currentTime = 0
    } catch (error) {
      console.error(error)
    } finally {
      fallback.muted = wasMuted
    }
  }, [getAlertAudioContext, getFallbackAlertAudio])

  const playAlertTone = useCallback(async () => {
    const context = getAlertAudioContext()

    if (!context) {
      throw new Error('Web Audio is unavailable.')
    }

    if (context.state === 'suspended') {
      await context.resume()
    }

    const startAt = context.currentTime + 0.01
    const pulses = [
      { frequency: 1320, offset: 0, duration: 0.1 },
      { frequency: 1320, offset: 0.16, duration: 0.1 },
      { frequency: 1568, offset: 0.32, duration: 0.1 },
      { frequency: 1568, offset: 0.48, duration: 0.14 },
    ]

    const sequenceDurationSeconds = Math.max(...pulses.map((pulse) => pulse.offset + pulse.duration))

    pulses.forEach((pulse) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const pulseStart = startAt + pulse.offset
      const pulseEnd = pulseStart + pulse.duration

      oscillator.type = 'square'
      oscillator.frequency.setValueAtTime(pulse.frequency, pulseStart)

      gain.gain.setValueAtTime(0.0001, pulseStart)
      gain.gain.exponentialRampToValueAtTime(0.42, pulseStart + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, pulseEnd)

      oscillator.connect(gain)
      gain.connect(context.destination)

      oscillator.start(pulseStart)
      oscillator.stop(pulseEnd)
    })

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, Math.ceil((sequenceDurationSeconds + 0.04) * 1000))
    })
  }, [getAlertAudioContext])

  const playFallbackAlertTone = useCallback(async () => {
    const audio = getFallbackAlertAudio()

    audio.pause()
    audio.currentTime = 0

    await audio.play()
    await new Promise<void>((resolve) => {
      let finished = false
      let timeoutId: number | null = null

      const done = () => {
        if (finished) {
          return
        }

        finished = true
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId)
        }

        audio.removeEventListener('ended', done)
        resolve()
      }

      timeoutId = window.setTimeout(done, 900)
      audio.addEventListener('ended', done)
    })
  }, [getFallbackAlertAudio])

  const alertUser = useCallback(async (options: { vibrate?: boolean } = {}) => {
    const vibrateEnabled = options.vibrate !== false

    const runAlert = async () => {
      try {
        await playAlertTone()
      } catch {
        try {
          await playFallbackAlertTone()
        } catch (fallbackError) {
          console.error(fallbackError)
        }
      }

      if (vibrateEnabled && navigator.vibrate) {
        navigator.vibrate([300, 200, 300])
      }
    }

    alertQueueRef.current = alertQueueRef.current.then(runAlert, runAlert)
    await alertQueueRef.current
  }, [playAlertTone, playFallbackAlertTone])

  const preprocessToGray = useCallback((sourceMat: any, targetMat: any) => {
    window.cv.cvtColor(sourceMat, targetMat, window.cv.COLOR_RGBA2GRAY)
    window.cv.equalizeHist(targetMat, targetMat)
    window.cv.GaussianBlur(targetMat, targetMat, new window.cv.Size(5, 5), 0)
  }, [])

  const clampRoiToMat = useCallback((sourceRoi: Rect | null, mat: any): Rect | null => {
    if (!sourceRoi || mat.cols === 0 || mat.rows === 0) {
      return null
    }

    const x = clamp(sourceRoi.x, 0, Math.max(0, mat.cols - 1))
    const y = clamp(sourceRoi.y, 0, Math.max(0, mat.rows - 1))
    const w = Math.min(sourceRoi.w, mat.cols - x)
    const h = Math.min(sourceRoi.h, mat.rows - y)

    if (w < MIN_ROI_SIZE || h < MIN_ROI_SIZE) {
      return null
    }

    return { x, y, w, h }
  }, [])

  const createTemplateVariant = useCallback((baseMat: any, scale: number): TemplateVariant | null => {
    const width = Math.max(1, Math.round(baseMat.cols * scale))
    const height = Math.max(1, Math.round(baseMat.rows * scale))

    if (width < MIN_ROI_SIZE || height < MIN_ROI_SIZE) {
      return null
    }

    const variantMat = new window.cv.Mat()
    const interpolation = scale < 1 ? window.cv.INTER_AREA : window.cv.INTER_LINEAR

    window.cv.resize(baseMat, variantMat, new window.cv.Size(width, height), 0, 0, interpolation)

    return { scale, mat: variantMat }
  }, [])

  const loadImage = useCallback((src: string) => {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Template image could not be loaded.'))
      img.src = src
    })
  }, [])

  const loadTemplateVariants = useCallback(async (src: string) => {
    clearTemplateVariants()

    const img = await loadImage(src)
    const rawTemplate = window.cv.imread(img)
    const processedTemplate = new window.cv.Mat()

    try {
      preprocessToGray(rawTemplate, processedTemplate)

      TEMPLATE_SCALES.forEach((scale) => {
        const variant = createTemplateVariant(processedTemplate, scale)
        if (variant) {
          templateVariantsRef.current.push(variant)
        }
      })
    } finally {
      rawTemplate.delete()
      processedTemplate.delete()
    }

    if (templateVariantsRef.current.length === 0) {
      throw new Error('Template sizes are invalid for matching.')
    }
  }, [clearTemplateVariants, createTemplateVariant, loadImage, preprocessToGray])

  const findBestMatch = useCallback((searchMat: any): Match | null => {
    let bestMatch: Match | null = null

    templateVariantsRef.current.forEach((variant) => {
      if (searchMat.cols < variant.mat.cols || searchMat.rows < variant.mat.rows) {
        return
      }

      const result = new window.cv.Mat()

      try {
        window.cv.matchTemplate(searchMat, variant.mat, result, window.cv.TM_CCOEFF_NORMED)

        const { maxVal, maxLoc } = window.cv.minMaxLoc(result)

        if (!bestMatch || maxVal > bestMatch.score) {
          bestMatch = {
            score: maxVal,
            x: maxLoc.x,
            y: maxLoc.y,
            w: variant.mat.cols,
            h: variant.mat.rows,
            scale: variant.scale,
          }
        }
      } finally {
        result.delete()
      }
    })

    return bestMatch
  }, [])

  const isCandidateStable = useCallback((candidate: Rect): boolean => {
    if (!previousCandidateRef.current) {
      return true
    }

    const previous = previousCandidateRef.current
    const dx = Math.abs(candidate.x - previous.x)
    const dy = Math.abs(candidate.y - previous.y)
    const dwRatio = Math.abs(candidate.w - previous.w) / Math.max(1, previous.w)
    const dhRatio = Math.abs(candidate.h - previous.h) / Math.max(1, previous.h)

    return (
      dx <= MATCH_POSITION_TOLERANCE_PX &&
      dy <= MATCH_POSITION_TOLERANCE_PX &&
      dwRatio <= MATCH_SIZE_TOLERANCE_RATIO &&
      dhRatio <= MATCH_SIZE_TOLERANCE_RATIO
    )
  }, [])

  const getDefaultStatus = useCallback(() => {
    if (detectionTimerRef.current !== null) {
      return detectionLockedRef.current ? 'Status: Match Locked' : 'Status: Detection Running'
    }

    if (roiRef.current) {
      return 'Status: Search area selected'
    }

    return 'Status: Idle'
  }, [])

  const stopMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    videoTrackRef.current = null
  }, [])

  const releaseFrameResources = useCallback(() => {
    if (frameMatRef.current) {
      frameMatRef.current.delete()
      frameMatRef.current = null
    }
    videoCaptureRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    const video = videoRef.current
    const canvas = overlayRef.current
    if (!video || !canvas) {
      return
    }

    try {
      await primeAlertAudio().catch(() => undefined)
      clearDetectionLoop()
      releaseFrameResources()
      stopMediaStream()

      setStatus('Status: Starting camera')

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })

      mediaStreamRef.current = stream
      video.srcObject = stream
      ;[videoTrackRef.current] = stream.getVideoTracks()

      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve()
      })

      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      await video.play()

      await waitForOpenCv()
      frameMatRef.current = new window.cv.Mat(video.videoHeight, video.videoWidth, window.cv.CV_8UC4)
      videoCaptureRef.current = new window.cv.VideoCapture(video)

      setStatus('Status: Camera ready')
      redrawOverlay()
    } catch (error) {
      setStatus('Status: Camera access failed')
      console.error(error)
    }
  }, [clearDetectionLoop, primeAlertAudio, redrawOverlay, releaseFrameResources, stopMediaStream, waitForOpenCv])

  const detectFrame = useCallback(() => {
    if (scanInProgressRef.current || !roiRef.current || templateVariantsRef.current.length === 0) {
      return
    }

    if (!videoCaptureRef.current || !frameMatRef.current) {
      setStatus('Status: Camera frame unavailable')
      return
    }

    scanInProgressRef.current = true

    let roiRgbaMat: any = null
    let roiGrayMat: any = null

    try {
      videoCaptureRef.current.read(frameMatRef.current)
      const safeRoi = clampRoiToMat(roiRef.current, frameMatRef.current)

      if (!safeRoi) {
        setStatus('Status: Search area is too small')
        clearCandidateState()
        setScore(0)
        redrawOverlay()
        return
      }

      // Performance improvement: preprocess only ROI, not the full frame.
      roiRgbaMat = frameMatRef.current.roi(new window.cv.Rect(safeRoi.x, safeRoi.y, safeRoi.w, safeRoi.h))
      roiGrayMat = new window.cv.Mat()
      preprocessToGray(roiRgbaMat, roiGrayMat)

      const bestMatch = findBestMatch(roiGrayMat)

      setFrameCount((count) => count + 1)
      setScore(bestMatch ? bestMatch.score : 0)

      if (!bestMatch) {
        setStatus('Status: Search area is smaller than template')
        clearCandidateState()
        redrawOverlay()
        return
      }

      if (bestMatch.score >= threshold && !detectionLockedRef.current) {
        const candidate = {
          x: safeRoi.x + bestMatch.x,
          y: safeRoi.y + bestMatch.y,
          w: bestMatch.w,
          h: bestMatch.h,
        }

        if (isCandidateStable(candidate)) {
          stableMatchCountRef.current += 1
        } else {
          stableMatchCountRef.current = 1
        }

        previousCandidateRef.current = candidate
        detectionsRef.current = [candidate]
        setStableHits(stableMatchCountRef.current)

        if (stableMatchCountRef.current < REQUIRED_STABLE_MATCHES) {
          setStatus(`Status: Candidate match ${stableMatchCountRef.current}/${REQUIRED_STABLE_MATCHES} (${bestMatch.score.toFixed(3)})`)
          redrawOverlay()
          return
        }

        detectionLockedRef.current = true
        setStatus(`Status: Match Found (${bestMatch.score.toFixed(3)})`)
        redrawOverlay()
        void alertUser()
        return
      }

      if (!detectionLockedRef.current) {
        clearCandidateState()
      }

      setStatus(getDefaultStatus())
      redrawOverlay()
    } catch (error) {
      setStatus('Status: Detection error')
      clearDetectionLoop()
      console.error(error)
    } finally {
      if (roiGrayMat) {
        roiGrayMat.delete()
      }
      if (roiRgbaMat) {
        roiRgbaMat.delete()
      }

      scanInProgressRef.current = false
    }
  }, [alertUser, clampRoiToMat, clearCandidateState, clearDetectionLoop, findBestMatch, getDefaultStatus, isCandidateStable, preprocessToGray, redrawOverlay, threshold])

  const startDetection = useCallback(async () => {
    const video = videoRef.current

    await primeAlertAudio().catch(() => undefined)

    if (!video?.srcObject || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      setStatus('Status: Start the camera first')
      return
    }

    if (!roiRef.current) {
      setStatus('Status: Draw a search area first')
      return
    }

    clearDetectionLoop()
    detectionsRef.current = []
    detectionLockedRef.current = false
    clearCandidateState()
    setFrameCount(0)
    setScore(0)
    redrawOverlay()

    try {
      setStatus('Status: Loading OpenCV')
      await waitForOpenCv()

      setStatus('Status: Loading template')
      await loadTemplateVariants('/star.png')

      setStatus('Status: Detection Running')
      detectionTimerRef.current = window.setInterval(detectFrame, SCAN_INTERVAL_MS)
    } catch (error) {
      setStatus('Status: Detection could not start')
      console.error(error)
    }
  }, [clearCandidateState, clearDetectionLoop, detectFrame, loadTemplateVariants, primeAlertAudio, redrawOverlay, waitForOpenCv])

  const resetDetections = useCallback(() => {
    detectionsRef.current = []
    detectionLockedRef.current = false
    clearCandidateState()
    setFrameCount(0)
    setScore(0)
    setStatus(getDefaultStatus())
    redrawOverlay()
  }, [clearCandidateState, getDefaultStatus, redrawOverlay])

  const testAlertTone = useCallback(async () => {
    await primeAlertAudio().catch(() => undefined)
    setStatus('Status: Testing alert')
    await alertUser({ vibrate: false })
    setStatus(getDefaultStatus())
  }, [alertUser, getDefaultStatus, primeAlertAudio])

  const drawSelectionPreview = useCallback((x1: number, y1: number, x2: number, y2: number) => {
    const canvas = overlayRef.current
    if (!canvas) {
      return
    }

    const preview = normalizeRect(x1, y1, x2, y2, canvas)

    redrawOverlay()

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    ctx.strokeStyle = 'yellow'
    ctx.lineWidth = 3
    ctx.strokeRect(preview.x, preview.y, preview.w, preview.h)
  }, [redrawOverlay])

  const setRoiFromPoints = useCallback((x1: number, y1: number, x2: number, y2: number) => {
    const canvas = overlayRef.current
    if (!canvas) {
      return
    }

    const nextRoi = normalizeRect(x1, y1, x2, y2, canvas)

    if (nextRoi.w < MIN_ROI_SIZE || nextRoi.h < MIN_ROI_SIZE) {
      roiRef.current = null
      detectionsRef.current = []
      detectionLockedRef.current = false
      clearCandidateState()
      setStatus('Status: Select a larger search area')
      redrawOverlay()
      return
    }

    roiRef.current = nextRoi
    detectionsRef.current = []
    detectionLockedRef.current = false
    clearCandidateState()
    setStatus('Status: Search area selected')
    redrawOverlay()
  }, [clearCandidateState, redrawOverlay])

  const handlePointerDown = useCallback((clientX: number, clientY: number) => {
    const canvas = overlayRef.current
    if (!canvas?.width || !canvas.height) {
      return
    }

    void primeAlertAudio().catch(() => undefined)

    const point = getCanvasPoint(clientX, clientY)
    drawingRef.current = true
    drawingStartRef.current = point
  }, [getCanvasPoint, primeAlertAudio])

  const handlePointerMove = useCallback((clientX: number, clientY: number) => {
    if (!drawingRef.current) {
      return
    }

    const point = getCanvasPoint(clientX, clientY)
    drawSelectionPreview(drawingStartRef.current.x, drawingStartRef.current.y, point.x, point.y)
  }, [drawSelectionPreview, getCanvasPoint])

  const handlePointerUp = useCallback((clientX: number, clientY: number) => {
    if (!drawingRef.current) {
      return
    }

    const point = getCanvasPoint(clientX, clientY)

    drawingRef.current = false
    setRoiFromPoints(drawingStartRef.current.x, drawingStartRef.current.y, point.x, point.y)
  }, [getCanvasPoint, setRoiFromPoints])

  useEffect(() => {
    const script = document.createElement('script')
    script.src = 'https://docs.opencv.org/4.x/opencv.js'
    script.async = true
    document.body.appendChild(script)

    return () => {
      script.remove()
    }
  }, [])

  useEffect(() => {
    return () => {
      clearDetectionLoop()
      stopMediaStream()
      releaseFrameResources()
      clearTemplateVariants()

      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        void audioContextRef.current.close()
      }
    }
  }, [clearDetectionLoop, clearTemplateVariants, releaseFrameResources, stopMediaStream])

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="badge">Fire-Type Vision</p>
        <h1>🔥 Charmander Star Detector</h1>
        <p className="subtitle">Converted to Vite + React + TypeScript with a faster ROI-first detector loop.</p>
      </header>

      <section className="panel controls-panel">
        <div className="button-row">
          <button onClick={() => void startCamera()}>Start Camera</button>
          <button onClick={() => void startDetection()}>Start Detection</button>
          <button className="test-btn" onClick={() => void testAlertTone()}>Test Beep</button>
          <button className="reset-btn" onClick={resetDetections}>Reset Detections</button>
        </div>

        <div className="control-row">
          <label htmlFor="thresholdSlider">Match Threshold</label>
          <input
            id="thresholdSlider"
            type="range"
            min="0.55"
            max="0.95"
            step="0.01"
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
          />
          <span className="value-pill">{threshold.toFixed(2)}</span>
        </div>
      </section>

      <section className="panel status-panel">
        <div id="status">{status}</div>
        <div id="stats">{statsText}</div>
      </section>

      <section className="panel video-panel">
        <div id="container">
          <video ref={videoRef} autoPlay playsInline muted />
          <canvas
            ref={overlayRef}
            onMouseDown={(event) => handlePointerDown(event.clientX, event.clientY)}
            onMouseMove={(event) => handlePointerMove(event.clientX, event.clientY)}
            onMouseUp={(event) => handlePointerUp(event.clientX, event.clientY)}
            onTouchStart={(event) => {
              event.preventDefault()
              const touch = event.touches[0]
              handlePointerDown(touch.clientX, touch.clientY)
            }}
            onTouchMove={(event) => {
              event.preventDefault()
              const touch = event.touches[0]
              handlePointerMove(touch.clientX, touch.clientY)
            }}
            onTouchEnd={(event) => {
              const touch = event.changedTouches[0]
              handlePointerUp(touch.clientX, touch.clientY)
            }}
          />
        </div>
      </section>
    </main>
  )
}

export default App
