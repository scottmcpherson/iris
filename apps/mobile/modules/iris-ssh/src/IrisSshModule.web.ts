import { registerWebModule, NativeModule } from 'expo';

// IrisSshModule is not available on the web platform.
class IrisSshModule extends NativeModule<{}> {
  async readHostKeyFingerprintJson(): Promise<string> {
    throw new Error("IrisSsh is not available on web.");
  }

  async connectJson(): Promise<string> {
    throw new Error("IrisSsh is not available on web.");
  }

  async executeJson(): Promise<string> {
    throw new Error("IrisSsh is not available on web.");
  }

  async disconnectJson(): Promise<void> {
    throw new Error("IrisSsh is not available on web.");
  }
}

export default registerWebModule(IrisSshModule, 'IrisSshModule');
