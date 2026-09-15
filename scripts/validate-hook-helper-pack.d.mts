export interface PackContext {
  electronPlatformName: string;
  arch: number | string;
}

export default function validateHookHelperForPack(context: PackContext): void;
