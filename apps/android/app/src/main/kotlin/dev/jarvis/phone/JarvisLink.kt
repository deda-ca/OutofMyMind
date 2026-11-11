package dev.jarvis.phone

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * The WebSocket to the Jarvis server (/api/stream), the same protocol as the
 * web client: apps/server/src/stream/protocol.ts. Signs in with the access
 * key (Authorization: Bearer). Reconnects by itself, with back-off, unless
 * the key is wrong or the certificate isn't trusted. Callbacks run on the
 * main thread.
 */
class JarvisLink(private val listener: Listener) {
    interface Listener {
        fun onState(state: State, detail: String)
        fun onMessage(message: JSONObject)
        /** The server's certificate isn't trusted by Android: the owner may trust this one (its SHA-256). */
        fun onUntrustedCertificate(fingerprint: String)
    }

    enum class State { DISCONNECTED, CONNECTING, CONNECTED }

    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var wanted = false
    private var attempt = 0
    private var config: Config? = null

    private data class Config(val url: String, val key: String, val pin: String?)

    /** Connected and the session started (audio can be sent). */
    @Volatile
    var ready = false
        private set

    fun connect(serverUrl: String, key: String, pin: String?) {
        close()
        val base = serverUrl.trim().trimEnd('/')
        val wsUrl = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("wss://") -> base
            else -> "wss://$base"
        } + "/api/stream"
        config = Config(wsUrl, key, pin)
        wanted = true
        attempt = 0
        open()
    }

    fun close() {
        wanted = false
        main.removeCallbacksAndMessages(null)
        ready = false
        socket?.close(1000, "bye")
        socket = null
    }

    fun send(message: JSONObject): Boolean = socket?.send(message.toString()) ?: false

    fun sendAudio(frame: ByteArray): Boolean = ready && (socket?.send(frame.toByteString()) ?: false)

    private fun open() {
        val c = config ?: return
        state(State.CONNECTING, if (attempt == 0) "Connecting…" else "Reconnecting…")
        val trust = PinningTrustManager(c.pin)
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val client = OkHttpClient.Builder()
            .sslSocketFactory(tls.socketFactory, trust)
            .hostnameVerifier { host, session ->
                HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session) ||
                    (c.pin != null && (session.peerCertificates.firstOrNull() as? X509Certificate)?.let { fingerprint(it) } == c.pin)
            }
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .build()
        val request = Request.Builder().url(c.url).header("Authorization", "Bearer ${c.key}").build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                webSocket.send(
                    JSONObject()
                        .put("type", "start")
                        .put("sampleRate", Microphone.SAMPLE_RATE)
                        .put("language", "English")
                        .put("device", "android")
                        .put("mode", "conversation")
                        // A shorter pause ends a phrase sooner (the default is 1.2 s). Too short is
                        // safe: if the owner carries on before Jarvis says a word, the request continues.
                        .put("settings", JSONObject().put("pauseMs", PAUSE_MS))
                        .toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = try { JSONObject(text) } catch (_: Exception) { return }
                main.post {
                    if (webSocket !== socket) return@post
                    if (message.optString("type") == "ready") {
                        ready = true
                        state(State.CONNECTED, "Connected")
                    }
                    listener.onMessage(message)
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {}

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { if (webSocket === socket) lost("Disconnected${if (reason.isNotBlank()) ": $reason" else ""}") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post {
                    if (webSocket !== socket) return@post
                    val presented = trust.presented
                    when {
                        response?.code == 401 || response?.code == 403 -> {
                            wanted = false
                            ready = false
                            state(State.DISCONNECTED, if (response.code == 401) "The access key was refused." else "The server refused the connection (${response.code}).")
                        }
                        presented != null && presented != c.pin && (t is SSLPeerUnverifiedException || t.cause is CertificateException || t is javax.net.ssl.SSLHandshakeException) -> {
                            wanted = false
                            ready = false
                            listener.onUntrustedCertificate(presented)
                            state(State.DISCONNECTED, "The server's certificate isn't one Android trusts: check its fingerprint, then trust it.")
                        }
                        else -> lost(t.message ?: t.javaClass.simpleName)
                    }
                }
            }
        })
    }

    private fun lost(why: String) {
        ready = false
        socket = null
        if (!wanted) {
            state(State.DISCONNECTED, why)
            return
        }
        // 1 s, 2 s, 5 s, then every 15 s.
        val delay = longArrayOf(1000, 2000, 5000, 15000)[minOf(attempt, 3)]
        attempt++
        state(State.CONNECTING, "$why. Trying again in ${delay / 1000} s…")
        main.postDelayed({ if (wanted) open() }, delay)
    }

    private fun state(state: State, detail: String) = listener.onState(state, detail)

    /** Android's own trust, plus one certificate the owner chose to trust (a self-signed server). */
    private class PinningTrustManager(private val pin: String?) : X509TrustManager {
        private val system: X509TrustManager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(null as KeyStore?) }
            .trustManagers.filterIsInstance<X509TrustManager>().first()

        /** The fingerprint of the certificate the server presented last. */
        @Volatile
        var presented: String? = null

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            val leaf = fingerprint(chain[0])
            presented = leaf
            if (pin != null && leaf == pin) return
            system.checkServerTrusted(chain, authType)
        }

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)

        override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
    }

    companion object {
        /** How long a pause ends a phrase (ms). */
        const val PAUSE_MS = 800

        /** "AB:CD:…", the certificate's SHA-256. */
        fun fingerprint(cert: X509Certificate): String =
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }
    }
}
