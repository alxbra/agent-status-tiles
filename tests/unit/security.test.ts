import { describe, expect, it } from 'vitest';

import { isAllowedRendererNavigation } from '../../src/main/security';

describe('isAllowedRendererNavigation', () => {
  it('allows navigation within the development renderer origin', () => {
    expect(
      isAllowedRendererNavigation('http://localhost:5173/settings', 'http://localhost:5173/'),
    ).toBe(true);
  });

  it('rejects external, credential-bearing, and malformed URLs', () => {
    expect(isAllowedRendererNavigation('https://example.com', 'http://localhost:5173/')).toBe(
      false,
    );
    expect(
      isAllowedRendererNavigation('http://user:password@localhost:5173/', 'http://localhost:5173/'),
    ).toBe(false);
    expect(isAllowedRendererNavigation('not-a-url', 'http://localhost:5173/')).toBe(false);
  });

  it('allows only the built renderer file path for packaged navigation', () => {
    expect(
      isAllowedRendererNavigation(
        'file:///Applications/Agent%20Status%20Tiles.app/Contents/Resources/app/out/renderer/index.html',
        'file:///Applications/Agent%20Status%20Tiles.app/Contents/Resources/app/out/renderer/index.html',
      ),
    ).toBe(true);
    expect(
      isAllowedRendererNavigation(
        'file:///Applications/Agent%20Status%20Tiles.app/Contents/Resources/app/out/renderer/other.html',
        'file:///Applications/Agent%20Status%20Tiles.app/Contents/Resources/app/out/renderer/index.html',
      ),
    ).toBe(false);
    expect(
      isAllowedRendererNavigation(
        'file://attacker.example/Applications/Agent%20Status%20Tiles.app/Contents/Resources/app/out/renderer/index.html',
        'file:///Applications/Agent%20Status%20Tiles.app/Contents/Resources/app/out/renderer/index.html',
      ),
    ).toBe(false);
  });
});
