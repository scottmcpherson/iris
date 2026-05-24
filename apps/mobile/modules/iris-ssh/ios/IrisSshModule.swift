import ExpoModulesCore
import NMSSH

public class IrisSshModule: Module {
  private var sessions: [String: NMSSHSession] = [:]

  public func definition() -> ModuleDefinition {
    Name("IrisSsh")

    AsyncFunction("readHostKeyFingerprintJson") { (payloadJson: String) -> String in
      let payload = try parseJson(payloadJson)
      let host = try requiredString(payload, "host")
      let port = try requiredInt(payload, "port")
      let username = optionalString(payload, "username") ?? "iris"
      let session = NMSSHSession(host: host, port: port, andUsername: username)
      session.fingerprintHash = NMSSHSessionHash.SHA1
      guard session.connect() else {
        throw IrisSshError.message("Could not connect to SSH host.")
      }
      let fingerprint = try normalizedFingerprint(session.fingerprint(NMSSHSessionHash.SHA1))
      session.disconnect()
      return try jsonString(["hostKeyFingerprint": fingerprint])
    }

    AsyncFunction("connectJson") { (payloadJson: String) -> String in
      let payload = try parseJson(payloadJson)
      let host = try requiredString(payload, "host")
      let port = try requiredInt(payload, "port")
      let username = try requiredString(payload, "username")
      let expectedFingerprint = try normalizedFingerprint(requiredString(payload, "expectedHostKeyFingerprint"))
      guard let auth = payload["auth"] as? [String: Any] else {
        throw IrisSshError.message("auth is required.")
      }

      let session = NMSSHSession(host: host, port: port, andUsername: username)
      session.fingerprintHash = NMSSHSessionHash.SHA1
      guard session.connect() else {
        throw IrisSshError.message("Could not connect to SSH host.")
      }
      let fingerprint = try normalizedFingerprint(session.fingerprint(NMSSHSessionHash.SHA1))
      guard fingerprintMatches(fingerprint, expectedFingerprint) else {
        session.disconnect()
        throw IrisSshError.message("SSH host key changed.")
      }

      let authKind = try requiredString(auth, "kind")
      if authKind == "password" {
        session.authenticate(byPassword: try requiredString(auth, "password"))
      } else if authKind == "key" {
        session.authenticate(
          byPublicKey: try requiredString(auth, "publicKey"),
          privateKey: try requiredString(auth, "privateKey"),
          andPassword: optionalString(auth, "passphrase")
        )
      } else {
        session.disconnect()
        throw IrisSshError.message("Unsupported SSH auth method.")
      }

      guard session.isAuthorized else {
        session.disconnect()
        throw IrisSshError.message("SSH authentication failed.")
      }

      let sessionId = UUID().uuidString
      sessions[sessionId] = session
      return try jsonString(["sessionId": sessionId, "hostKeyFingerprint": fingerprint])
    }

    AsyncFunction("executeJson") { (payloadJson: String) -> String in
      let payload = try parseJson(payloadJson)
      let sessionId = try requiredString(payload, "sessionId")
      let command = try requiredString(payload, "command")
      let timeoutMs = payload["timeoutMs"] as? Int ?? 30_000
      guard let session = sessions[sessionId] else {
        throw IrisSshError.message("Unknown SSH session.")
      }
      var error: NSError?
      let output = session.channel.execute(command, error: &error, timeout: NSNumber(value: max(1, timeoutMs / 1000)))
      if let error {
        return try jsonString(["stdout": output ?? "", "stderr": error.localizedDescription, "exitCode": 1])
      }
      return try jsonString(["stdout": output ?? "", "stderr": "", "exitCode": 0])
    }

    AsyncFunction("disconnectJson") { (payloadJson: String) in
      let payload = try parseJson(payloadJson)
      let sessionId = try requiredString(payload, "sessionId")
      if let session = sessions.removeValue(forKey: sessionId) {
        session.disconnect()
      }
    }
  }
}

private enum IrisSshError: Error {
  case message(String)
}

private func parseJson(_ value: String) throws -> [String: Any] {
  guard let data = value.data(using: .utf8),
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw IrisSshError.message("Invalid JSON payload.")
  }
  return object
}

private func jsonString(_ value: [String: Any]) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: value)
  return String(data: data, encoding: .utf8) ?? "{}"
}

private func requiredString(_ payload: [String: Any], _ name: String) throws -> String {
  guard let value = payload[name] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    throw IrisSshError.message("\(name) is required.")
  }
  return value
}

private func optionalString(_ payload: [String: Any], _ name: String) -> String? {
  guard let value = payload[name] as? String else {
    return nil
  }
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

private func requiredInt(_ payload: [String: Any], _ name: String) throws -> Int {
  guard let value = payload[name] as? Int, value > 0, value <= 65_535 else {
    throw IrisSshError.message("\(name) is not a valid port.")
  }
  return value
}

private func normalizedFingerprint(_ value: String?) throws -> String {
  guard let value else {
    throw IrisSshError.message("SSH host key was not available.")
  }
  let fingerprint = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
  return fingerprint.hasPrefix("SHA1:") ? fingerprint : "SHA1:\(fingerprint)"
}

private func fingerprintMatches(_ left: String, _ right: String) -> Bool {
  return left.replacingOccurrences(of: "SHA1:", with: "") == right.replacingOccurrences(of: "SHA1:", with: "")
}
