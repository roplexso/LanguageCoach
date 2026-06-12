import { useState, useRef, useEffect } from 'react'
import {
	View,
	Text,
	TouchableOpacity,
	StyleSheet,
	ActivityIndicator,
} from 'react-native'
import { Audio } from 'expo-av'
import * as Speech from 'expo-speech'
import * as FileSystem from 'expo-file-system/legacy'
import notifee from '@notifee/react-native'

const GROQ_API_KEY = 'your-groq-api-key-here'

const SILENCE_THRESHOLD = -35 // dB — below this = silence
const SPEECH_MIN_DURATION = 1500 // ms — ignore sounds shorter than this
const SILENCE_TIMEOUT = 2000 // ms — stop recording after 2s of silence
const MAX_RECORD_DURATION = 15000 // ms — max 15s per sentence

notifee.registerForegroundService(() => {
	return new Promise(() => {
		console.log('🔔 Foreground service running')
	})
})

export default function App() {
	const [isRunning, setIsRunning] = useState(false)
	const [status, setStatus] = useState('idle')
	const [transcript, setTranscript] = useState('')
	const [correction, setCorrection] = useState('')
	const [logs, setLogs] = useState([])

	const recordingRef = useRef(null)
	const isRecordingRef = useRef(false)
	const loopRef = useRef(false)
	const speechStartedRef = useRef(false)
	const silenceTimerRef = useRef(null)
	const maxDurationTimerRef = useRef(null)
	const processTriggerRef = useRef(null) // resolves when speech ends
	const testIntervalRef = useRef(null)

	const addLog = (msg) => {
		console.log(msg)
		setLogs((prev) => [msg, ...prev].slice(0, 10))
	}
	testIntervalRef.current = setInterval(async () => {
		if (!recordingRef.current) {
			clearInterval(testIntervalRef.current)
			return
		}
		const status = await recordingRef.current.getStatusAsync()
		addLog(
			`🧪 isRecording:${status.isRecording} metering:${(status.metering ?? -999).toFixed(0)}`,
		)
	}, 1000)

	useEffect(() => {
		;(async () => {
			const { granted } = await Audio.requestPermissionsAsync()
			addLog(`Mic permission: ${granted}`)
			await notifee.requestPermission()
			const batteryOptimizationEnabled =
				await notifee.isBatteryOptimizationEnabled()
			if (batteryOptimizationEnabled) {
				await notifee.openBatteryOptimizationSettings()
			}
		})()
	}, [])

	async function startCoach() {
		addLog('▶ startCoach called')
		loopRef.current = true
		setIsRunning(true)

		const channelId = await notifee.createChannel({
			id: 'language_coach',
			name: 'Language Coach',
		})

		await notifee.displayNotification({
			title: 'Language Coach is active',
			body: 'Listening for speech...',
			android: {
				channelId,
				asForegroundService: true,
				ongoing: true,
				pressAction: { id: 'default' },
			},
		})

		listenLoop()
	}

	async function stopCoach() {
		if (testIntervalRef.current) clearInterval(testIntervalRef.current)
		addLog('⏹ stopCoach called')
		loopRef.current = false
		isRecordingRef.current = false
		speechStartedRef.current = false
		setIsRunning(false)
		setStatus('idle')

		// Clear all timers
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
		if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current)

		// Resolve any pending process trigger
		if (processTriggerRef.current) {
			processTriggerRef.current()
			processTriggerRef.current = null
		}

		if (recordingRef.current) {
			try {
				await recordingRef.current.stopAndUnloadAsync()
			} catch (e) {}
			recordingRef.current = null
		}

		await Audio.setAudioModeAsync({ allowsRecordingIOS: false })
		await notifee.stopForegroundService()
	}

	async function listenLoop() {
		addLog('🔄 VAD listen loop started')
		while (loopRef.current) {
			try {
				await listenForSpeech()
				if (!loopRef.current) break
				await wait(300)
			} catch (e) {
				addLog(`❌ loop error: ${e.message}`)
				await wait(1000)
			}
		}
		addLog('🔄 listen loop ended')
	}

	async function listenForSpeech() {
		if (isRecordingRef.current) return

		addLog('👂 waiting for speech...')
		setStatus('idle')

		await Audio.setAudioModeAsync({
			allowsRecordingIOS: true,
			playsInSilentModeIOS: true,
			staysActiveInBackground: true,
		})

		const { recording } = await Audio.Recording.createAsync(
			{
				android: {
					extension: '.wav',
					outputFormat: Audio.AndroidOutputFormat.DEFAULT,
					audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
					sampleRate: 16000,
					numberOfChannels: 1,
					bitRate: 128000,
					isMeteringEnabled: true, // ← add this
				},
				ios: {
					extension: '.wav',
					audioQuality: Audio.IOSAudioQuality.HIGH,
					sampleRate: 16000,
					numberOfChannels: 1,
					bitRate: 128000,
					isMeteringEnabled: true, // ← add this
				},
				web: {},
			},
			undefined,
			100,
		)

		recordingRef.current = recording
		isRecordingRef.current = true
		speechStartedRef.current = false

		// Promise that resolves when speech ends
		const speechEnded = new Promise((resolve) => {
			processTriggerRef.current = resolve
		})

		// Track when speech first started
		let speechStartTime = null

		recording.setOnRecordingStatusUpdate((status) => {
			const db = status.metering ?? -160
			if (db > -100) addLog(`📊 db: ${db.toFixed(0)}`) // only log non-silence

			if (!loopRef.current || !status.isRecording) return

			// REMOVED the second "const db" line — already declared above

			if (db > SILENCE_THRESHOLD) {
				// Sound detected
				if (!speechStartedRef.current) {
					speechStartTime = Date.now()
					speechStartedRef.current = true
					addLog(`🔊 speech detected (${db.toFixed(0)}dB)`)
					setStatus('recording')
					// ... rest continues

					// Set max duration safety timer
					maxDurationTimerRef.current = setTimeout(() => {
						addLog('⏱ max duration reached')
						if (processTriggerRef.current) {
							processTriggerRef.current()
							processTriggerRef.current = null
						}
					}, MAX_RECORD_DURATION)
				}

				// Reset silence timer every time we hear sound
				if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
				silenceTimerRef.current = setTimeout(() => {
					const duration = speechStartTime ? Date.now() - speechStartTime : 0
					if (duration >= SPEECH_MIN_DURATION) {
						addLog(`🔇 silence detected, speech was ${duration}ms`)
						if (processTriggerRef.current) {
							processTriggerRef.current()
							processTriggerRef.current = null
						}
					} else {
						addLog(`⏭ too short (${duration}ms), ignoring`)
						speechStartedRef.current = false
						speechStartTime = null
					}
				}, SILENCE_TIMEOUT)
			}
		})
		// Test: log recording status every second manually
		const testInterval = setInterval(async () => {
			if (!recordingRef.current) {
				clearInterval(testInterval)
				return
			}
			const status = await recordingRef.current.getStatusAsync()
			addLog(
				`🧪 isRecording:${status.isRecording} metering:${status.metering?.toFixed(0) ?? 'null'}`,
			)
		}, 1000)

		// Wait until speech ends OR coach is stopped
		await speechEnded

		// Clear timers
		if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
		if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current)

		if (!loopRef.current) return

		// Only process if speech was actually detected
		if (!speechStartedRef.current) {
			await recording.stopAndUnloadAsync()
			recordingRef.current = null
			isRecordingRef.current = false
			return
		}

		// Process the audio
		await processRecording()
	}

	async function processRecording() {
		clearInterval(testInterval)
		if (!recordingRef.current) return

		addLog('⏹ stopping and processing...')
		isRecordingRef.current = false
		speechStartedRef.current = false
		setStatus('thinking')

		await recordingRef.current.stopAndUnloadAsync()
		const uri = recordingRef.current.getURI()
		recordingRef.current = null

		addLog('📤 transcribing...')
		const text = await transcribeAudio(uri)
		addLog(`📝 transcript: "${text}"`)

		const cleaned = text.trim().replace(/[^a-zA-Z]/g, '')
		if (!text || cleaned.length < 4) {
			addLog('⏭ skipping short transcript')
			setStatus('idle')
			return
		}

		setTranscript(text)

		addLog('🤖 getting correction...')
		const result = await getCorrection(text)
		addLog(`✅ correction: "${result.slice(0, 50)}"`)
		setCorrection(result)

		if (!result.toLowerCase().includes('good sentence')) {
			await new Promise((resolve) => {
				Speech.speak(result, { rate: 0.9, onDone: resolve, onError: resolve })
			})
			await wait(800)
		}

		setStatus('idle')
	}

	async function transcribeAudio(uri) {
		const uploadResult = await FileSystem.uploadAsync(
			'https://api.groq.com/openai/v1/audio/transcriptions',
			uri,
			{
				httpMethod: 'POST',
				uploadType: 1,
				fieldName: 'file',
				mimeType: 'audio/wav',
				parameters: { model: 'whisper-large-v3', language: 'en' },
				headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
			},
		)
		const data = JSON.parse(uploadResult.body)
		return data.text ?? ''
	}

	async function getCorrection(text) {
		const response = await fetch(
			'https://api.groq.com/openai/v1/chat/completions',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${GROQ_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'llama-3.3-70b-versatile',
					max_tokens: 150,
					messages: [
						{
							role: 'user',
							content: `You are a language teacher. The student just said: "${text}"
If the grammar, word choice, or phrasing is incorrect or unnatural, correct it and briefly explain why.
If it is perfectly fine, say exactly "Good sentence!"
Keep your response short, max 2 sentences.`,
						},
					],
				}),
			},
		)
		const data = await response.json()
		return data.choices[0].message.content
	}

	function wait(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	const isThinking = status === 'thinking'
	const isListening = status === 'recording'
	const hasMistake =
		correction && !correction.toLowerCase().includes('good sentence')

	return (
		<View style={styles.container}>
			<Text style={styles.title}>Language Coach</Text>
			<Text style={styles.subtitle}>
				{isRunning ? 'Coach is active 🟢' : 'Coach is off 🔴'}
			</Text>

			<View style={styles.logBox}>
				{logs.map((log, i) => (
					<Text key={i} style={styles.logText}>
						{log}
					</Text>
				))}
			</View>

			<View style={styles.statusBox}>
				<Text style={styles.statusText}>
					{isListening
						? '🎤 Recording speech...'
						: isThinking
							? '⏳ Processing...'
							: isRunning
								? '👂 Waiting for speech...'
								: '—'}
				</Text>
			</View>

			<View style={styles.card}>
				<Text style={styles.label}>You said</Text>
				<Text style={styles.text}>{transcript || '—'}</Text>
			</View>

			<View style={[styles.card, hasMistake && styles.cardError]}>
				<Text style={styles.label}>Teacher</Text>
				{isThinking ? (
					<ActivityIndicator color='#666' />
				) : (
					<Text style={styles.text}>{correction || '—'}</Text>
				)}
			</View>

			<TouchableOpacity
				style={[styles.button, isRunning && styles.buttonStop]}
				onPress={isRunning ? stopCoach : startCoach}
				activeOpacity={0.8}
			>
				<Text style={styles.buttonText}>
					{isRunning ? '⏹  Stop Coach' : '▶  Start Coach'}
				</Text>
			</TouchableOpacity>
		</View>
	)
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#f5f5f5',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	title: { fontSize: 24, fontWeight: '700', color: '#1a1a1a', marginBottom: 4 },
	subtitle: { fontSize: 13, color: '#888', marginBottom: 12 },
	logBox: {
		width: '100%',
		backgroundColor: '#1a1a1a',
		borderRadius: 12,
		padding: 10,
		marginBottom: 12,
		minHeight: 120,
	},
	logText: {
		fontSize: 11,
		color: '#00ff88',
		fontFamily: 'monospace',
		marginBottom: 2,
	},
	statusBox: {
		width: '100%',
		backgroundColor: '#e8f4fd',
		borderRadius: 12,
		padding: 10,
		marginBottom: 12,
		alignItems: 'center',
	},
	statusText: { fontSize: 14, color: '#2980b9', fontWeight: '600' },
	card: {
		width: '100%',
		backgroundColor: '#fff',
		borderRadius: 16,
		padding: 14,
		marginBottom: 12,
		minHeight: 60,
		justifyContent: 'center',
		shadowColor: '#000',
		shadowOpacity: 0.05,
		shadowRadius: 8,
		elevation: 2,
	},
	cardError: { borderLeftWidth: 4, borderLeftColor: '#ff6b6b' },
	label: {
		fontSize: 10,
		fontWeight: '600',
		color: '#aaa',
		textTransform: 'uppercase',
		marginBottom: 4,
	},
	text: { fontSize: 15, color: '#333', lineHeight: 20 },
	button: {
		marginTop: 8,
		backgroundColor: '#1a1a1a',
		paddingVertical: 16,
		paddingHorizontal: 44,
		borderRadius: 50,
	},
	buttonStop: { backgroundColor: '#ff6b6b' },
	buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
