export type HelperArch = 'arm64' | 'x64';

export const ARCHITECTURES: Readonly<Record<HelperArch, { target: string; cpuType: number }>>;

export interface BuildOptions {
  arch: HelperArch | 'both';
  cargoPath: string;
  architectures: HelperArch[];
}

export function parseBuildOptions(argv: string[], environment?: NodeJS.ProcessEnv): BuildOptions;
export function resourcePath(arch: string): string;
export function validateMachOArchitecture(binaryPath: string, arch: HelperArch): void;
