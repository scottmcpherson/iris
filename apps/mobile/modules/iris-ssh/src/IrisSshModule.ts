import { NativeModule, requireNativeModule } from 'expo';

declare class IrisSshModule extends NativeModule<{}> {
  readHostKeyFingerprintJson(payloadJson: string): Promise<string>;
  connectJson(payloadJson: string): Promise<string>;
  executeJson(payloadJson: string): Promise<string>;
  disconnectJson(payloadJson: string): Promise<void>;
}

export default requireNativeModule<IrisSshModule>('IrisSsh');
