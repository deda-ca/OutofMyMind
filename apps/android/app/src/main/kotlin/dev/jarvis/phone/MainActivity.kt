package dev.jarvis.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The one screen (docs/android-client.md): the server's address and the
 * access key, then "Start listening". From then on the phone listens (screen
 * off, locked, app closed) until "Stop listening", here or in the
 * notification. Everything said is transcribed by the server; "Jarvis, …"
 * gets an answer.
 */
class MainActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var server: EditText
    private lateinit var key: EditText
    private lateinit var status: TextView
    private lateinit var trustPanel: LinearLayout
    private lateinit var fingerprint: TextView
    private lateinit var listen: Button
    private lateinit var hearing: TextView
    private lateinit var stopTalking: Button
    private lateinit var heard: TextView
    private lateinit var reply: TextView

    private val render: () -> Unit = { show() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settings = Settings(this)
        server = findViewById(R.id.server)
        key = findViewById(R.id.key)
        status = findViewById(R.id.status)
        trustPanel = findViewById(R.id.trustPanel)
        fingerprint = findViewById(R.id.fingerprint)
        listen = findViewById(R.id.listen)
        hearing = findViewById(R.id.hearing)
        stopTalking = findViewById(R.id.stopTalking)
        heard = findViewById(R.id.heard)
        reply = findViewById(R.id.reply)

        server.setText(settings.serverUrl)
        key.setText(settings.accessKey)
        listen.setOnClickListener { if (ListeningService.Status.listening) ListeningService.stop(this) else startListening() }
        stopTalking.setOnClickListener { ListeningService.current?.stopTalking() }
        findViewById<Button>(R.id.trust).setOnClickListener { trustCertificate() }
        if (settings.serverUrl.isBlank()) status.text = "Type the server's address and the access key, then Start listening."
    }

    override fun onStart() {
        super.onStart()
        ListeningService.Status.observers.add(render)
        show()
    }

    override fun onStop() {
        ListeningService.Status.observers.remove(render)
        super.onStop()
    }

    private fun startListening() {
        val url = server.text.toString().trim().trimEnd('/')
        val accessKey = key.text.toString().trim()
        if (url.isBlank() || accessKey.isBlank()) {
            status.text = "Both the server's address and the access key are needed."
            return
        }
        if (!url.startsWith("https://")) {
            status.text = "Use an https:// address (the audio and the key must be encrypted)."
            return
        }
        settings.serverUrl = url
        settings.accessKey = accessKey
        // The microphone first (needed), then notifications (to see and stop it), then not being put to sleep.
        val missing = buildList {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.RECORD_AUDIO)
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), PERMISSIONS)
            return
        }
        askNotToSleep()
        ListeningService.Status.connection = "Connecting…"
        ListeningService.start(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status.text = "Jarvis needs the microphone to hear you."
            return
        }
        startListening()
    }

    /** Once: ask to be left out of battery optimisation, or the phone cuts the network while it sleeps. */
    @SuppressLint("BatteryLife")
    private fun askNotToSleep() {
        val power = getSystemService(PowerManager::class.java)
        if (power.isIgnoringBatteryOptimizations(packageName)) return
        val prefs = getSharedPreferences("jarvis", MODE_PRIVATE)
        if (prefs.getBoolean("askedBattery", false)) return
        prefs.edit().putBoolean("askedBattery", true).apply()
        try {
            startActivity(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            // Some phones don't have the dialog.
        }
    }

    private fun trustCertificate() {
        val fp = ListeningService.Status.untrusted ?: return
        AlertDialog.Builder(this)
            .setTitle("Trust this certificate?")
            .setMessage(
                "The server's certificate isn't signed by an authority Android knows (normal for Jarvis's own self-signed one).\n\n" +
                    "Only trust it if this fingerprint is your server's:\n\n$fp",
            )
            .setPositiveButton("Trust") { _, _ ->
                settings.pinnedFingerprint = fp
                ListeningService.Status.untrusted = null
                startListening()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun show() {
        val s = ListeningService.Status
        listen.setText(if (s.listening) R.string.stop_listening else R.string.start_listening)
        server.isEnabled = !s.listening
        key.isEnabled = !s.listening
        if (s.connection.isNotBlank()) status.text = s.connection
        trustPanel.visibility = if (s.untrusted != null && !s.listening) View.VISIBLE else View.GONE
        fingerprint.text = s.untrusted?.let { "SHA-256 $it" } ?: ""
        hearing.text = when {
            !s.listening -> ""
            !s.connected -> "○ Not connected: speech isn't being sent"
            s.hearing -> "● Hearing speech"
            else -> "○ Quiet"
        }
        stopTalking.isEnabled = s.talking
        heard.text = s.heard.joinToString("\n") { "“$it”" }
        reply.text = s.reply
    }

    private companion object {
        const val PERMISSIONS = 1
    }
}
