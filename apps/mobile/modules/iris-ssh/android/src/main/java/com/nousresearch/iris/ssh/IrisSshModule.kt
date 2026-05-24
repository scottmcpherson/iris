package com.nousresearch.iris.ssh

import android.util.Base64
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.Properties
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

class IrisSshModule : Module() {
  private val sessions = ConcurrentHashMap<String, Session>()

  override fun definition() = ModuleDefinition {
    Name("IrisSsh")

    AsyncFunction("readHostKeyFingerprintJson") Coroutine { payloadJson: String ->
      val payload = JSONObject(payloadJson)
      val host = payload.requiredString("host")
      val port = payload.requiredInt("port")
      val username = payload.optionalString("username") ?: "iris"
      val session = JSch().getSession(username, host, port)
      session.setConfig(Properties().apply {
        setProperty("StrictHostKeyChecking", "no")
        setProperty("PreferredAuthentications", "none,password,publickey,keyboard-interactive")
      })
      try {
        session.connect(10_000)
      } catch (error: JSchException) {
        if (session.hostKey == null) {
          throw error
        }
      } finally {
        session.disconnect()
      }
      val fingerprint = session.hostKey?.toSha1Fingerprint()
        ?: throw IllegalStateException("SSH host key was not available.")
      JSONObject(mapOf("hostKeyFingerprint" to fingerprint)).toString()
    }

    AsyncFunction("connectJson") Coroutine { payloadJson: String ->
      val payload = JSONObject(payloadJson)
      val host = payload.requiredString("host")
      val port = payload.requiredInt("port")
      val username = payload.requiredString("username")
      val expectedFingerprint = payload.requiredString("expectedHostKeyFingerprint")
      val auth = payload.getJSONObject("auth")
      val jsch = JSch()
      jsch.setHostKeyRepository(FingerprintHostKeyRepository(expectedFingerprint))
      if (auth.requiredString("kind") == "key") {
        val privateKey = auth.requiredString("privateKey").toByteArray(Charsets.UTF_8)
        val passphrase = auth.optionalString("passphrase")?.toByteArray(Charsets.UTF_8)
        jsch.addIdentity("iris-mobile", privateKey, null, passphrase)
      }

      val session = jsch.getSession(username, host, port)
      if (auth.requiredString("kind") == "password") {
        session.setPassword(auth.requiredString("password"))
      }
      session.setConfig(Properties().apply {
        setProperty("StrictHostKeyChecking", "yes")
      })
      session.connect(15_000)

      val fingerprint = session.hostKey?.toSha1Fingerprint()
        ?: throw IllegalStateException("SSH host key was not available.")
      if (!fingerprint.sameFingerprint(expectedFingerprint)) {
        session.disconnect()
        throw SecurityException("SSH host key changed.")
      }
      val sessionId = UUID.randomUUID().toString()
      sessions[sessionId] = session
      JSONObject(mapOf("sessionId" to sessionId, "hostKeyFingerprint" to fingerprint)).toString()
    }

    AsyncFunction("executeJson") Coroutine { payloadJson: String ->
      val payload = JSONObject(payloadJson)
      val sessionId = payload.requiredString("sessionId")
      val command = payload.requiredString("command")
      val timeoutMs = payload.optInt("timeoutMs", 30_000)
      val session = sessions[sessionId] ?: throw IllegalStateException("Unknown SSH session.")
      val result = execute(session, command, timeoutMs)
      JSONObject(
        mapOf(
          "stdout" to result.stdout,
          "stderr" to result.stderr,
          "exitCode" to result.exitCode,
        ),
      ).toString()
    }

    AsyncFunction("disconnectJson") Coroutine { payloadJson: String ->
      val payload = JSONObject(payloadJson)
      val session = sessions.remove(payload.requiredString("sessionId"))
      session?.disconnect()
    }
  }

  private fun execute(session: Session, command: String, timeoutMs: Int): ExecuteResult {
    val channel = session.openChannel("exec") as ChannelExec
    val stdout = ByteArrayOutputStream()
    val stderr = ByteArrayOutputStream()
    channel.setCommand(command)
    channel.setInputStream(null)
    channel.setErrStream(stderr)
    val input = channel.inputStream
    channel.connect(timeoutMs)
    val buffer = ByteArray(8192)
    while (true) {
      while (input.available() > 0) {
        val read = input.read(buffer, 0, buffer.size)
        if (read < 0) break
        stdout.write(buffer, 0, read)
      }
      if (channel.isClosed) {
        while (input.available() > 0) {
          val read = input.read(buffer, 0, buffer.size)
          if (read < 0) break
          stdout.write(buffer, 0, read)
        }
        val exitCode = channel.exitStatus
        channel.disconnect()
        return ExecuteResult(
          stdout.toString(Charsets.UTF_8.name()),
          stderr.toString(Charsets.UTF_8.name()),
          exitCode,
        )
      }
      Thread.sleep(25)
    }
  }
}

private data class ExecuteResult(val stdout: String, val stderr: String, val exitCode: Int)

private class FingerprintHostKeyRepository(private val expectedFingerprint: String) : HostKeyRepository {
  override fun check(host: String?, key: ByteArray?): Int {
    if (key == null) return HostKeyRepository.CHANGED
    return if (sha1Fingerprint(key).sameFingerprint(expectedFingerprint)) {
      HostKeyRepository.OK
    } else {
      HostKeyRepository.CHANGED
    }
  }

  override fun add(hostkey: HostKey?, ui: com.jcraft.jsch.UserInfo?) = Unit
  override fun remove(host: String?, type: String?) = Unit
  override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
  override fun getKnownHostsRepositoryID() = "iris-mobile-secure-store"
  override fun getHostKey(): Array<HostKey> = emptyArray()
  override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
}

private fun HostKey.toSha1Fingerprint(): String {
  val keyBytes = Base64.decode(key, Base64.DEFAULT)
  return sha1Fingerprint(keyBytes)
}

private fun sha1Fingerprint(keyBytes: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-1").digest(keyBytes)
  return "SHA1:" + digest.joinToString(":") { byte -> "%02X".format(byte) }
}

private fun String.sameFingerprint(other: String) =
  normalizeFingerprint(this) == normalizeFingerprint(other)

private fun normalizeFingerprint(value: String) =
  value.trim().uppercase(Locale.ROOT).removePrefix("SHA1:")

private fun JSONObject.requiredString(name: String): String {
  val value = optString(name, "")
  if (value.isBlank()) throw IllegalArgumentException("$name is required.")
  return value
}

private fun JSONObject.optionalString(name: String): String? {
  val value = optString(name, "")
  return value.ifBlank { null }
}

private fun JSONObject.requiredInt(name: String): Int {
  if (!has(name)) throw IllegalArgumentException("$name is required.")
  val value = getInt(name)
  if (value <= 0 || value > 65535) throw IllegalArgumentException("$name is not a valid port.")
  return value
}
