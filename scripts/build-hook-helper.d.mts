export type HelperArch = 'arm64' | 'x64';

export const ARCHITECTURES: Readonly<Record<HelperArch, { target: string; cpuType: number }>>;

export interface BuildOptions {
  arch: HelperArch | 'both';
  cargoPath: string;
  /** False when Cargo comes from the default lookup rather than configuration. */
  cargoExplicit: boolean;
  ifMissing: boolean;
  optional: boolean;
  architectures: HelperArch[];
}

export function parseBuildOptions(
  argv: string[],
  environment?: NodeJS.ProcessEnv,
  processArch?: string,
): BuildOptions;
export function cargoCandidates(environment?: NodeJS.ProcessEnv, home?: string): string[];
export function getHelperBuildPath(arch: string): string;
export function getCargoBuildArguments(target: string): string[];
export function validateMachOArchitecture(binaryPath: string, arch: HelperArch): void;
export function validateBuiltHelper(arch: HelperArch): string;
