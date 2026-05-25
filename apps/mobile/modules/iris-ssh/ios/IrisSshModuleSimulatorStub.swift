import ExpoModulesCore

public class IrisSshModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IrisSsh")

    AsyncFunction("readHostKeyFingerprintJson") { (_: String) -> String in
      throw IrisSshUnavailableError.message(unavailableMessage)
    }

    AsyncFunction("connectJson") { (_: String) -> String in
      throw IrisSshUnavailableError.message(unavailableMessage)
    }

    AsyncFunction("executeJson") { (_: String) -> String in
      throw IrisSshUnavailableError.message(unavailableMessage)
    }

    AsyncFunction("disconnectJson") { (_: String) in
    }
  }
}

private let unavailableMessage = "Native SSH is not available in this iOS simulator build."

private enum IrisSshUnavailableError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let message):
      return message
    }
  }
}
