package dev.jarvis.phone

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * What the app remembers: the server's address, the access key (encrypted
 * with a key that never leaves the Android Keystore), and the server
 * certificate the owner chose to trust (its SHA-256 fingerprint), for a
 * server with a self-signed certificate.
 */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "") ?: ""
        set(value) = prefs.edit().putString("serverUrl", value.trim().trimEnd('/')).apply()

    /** The trusted certificate's fingerprint for the current server, if the owner trusted one. */
    var pinnedFingerprint: String?
        get() = prefs.getString("pin:$serverUrl", null)
        set(value) = prefs.edit().apply { if (value == null) remove("pin:$serverUrl") else putString("pin:$serverUrl", value) }.apply()

    var accessKey: String
        get() = prefs.getString("accessKey", null)?.let { decrypt(it) } ?: ""
        set(value) = prefs.edit().putString("accessKey", encrypt(value.trim())).apply()

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val sealed = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String? = try {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes, 0, 12))
        String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    } catch (_: Exception) {
        null // the Keystore key is gone (app data restored elsewhere): type the key again
    }

    private companion object {
        const val KEY_ALIAS = "jarvis-access-key"
    }
}
