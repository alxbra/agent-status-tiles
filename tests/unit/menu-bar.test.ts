import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MenuItem = {
  click?: () => void;
  label?: string;
  type?: string;
};

const electronMocks = vi.hoisted(() => ({
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Tray: vi.fn(),
  nativeImage: {
    createFromDataURL: vi.fn(() => ({ setTemplateImage: vi.fn() })),
  },
}));

vi.mock('electron', () => electronMocks);

function createTrayMock() {
  return {
    destroy: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
  };
}

describe('menu bar', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMocks.Menu.buildFromTemplate.mockReset();
    electronMocks.Menu.buildFromTemplate.mockReturnValue({});
    electronMocks.Tray.mockReset();
    electronMocks.nativeImage.createFromDataURL.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a template tray icon with the required native actions', async () => {
    const tray = createTrayMock();
    electronMocks.Tray.mockImplementation(
      class TrayMock {
        constructor() {
          return tray;
        }
      } as unknown as typeof electronMocks.Tray,
    );
    const actions = {
      showOverlay: vi.fn(),
      hideOverlay: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
    };
    const { createMenuBar } = await import('../../src/main/menu-bar');

    const controller = createMenuBar(actions);
    const icon = electronMocks.nativeImage.createFromDataURL.mock.results[0]?.value as {
      setTemplateImage: ReturnType<typeof vi.fn>;
    };
    const menuCall = electronMocks.Menu.buildFromTemplate.mock.calls[0] as unknown as [MenuItem[]];
    const template = menuCall[0];

    expect(icon.setTemplateImage).toHaveBeenCalledWith(true);
    expect(tray.setToolTip).toHaveBeenCalledWith('Agent Status Tiles');
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      'Show',
      'Hide',
      'separator',
      'Settings',
      'Quit',
    ]);

    template.find((item) => item.label === 'Show')?.click?.();
    template.find((item) => item.label === 'Hide')?.click?.();
    template.find((item) => item.label === 'Settings')?.click?.();
    template.find((item) => item.label === 'Quit')?.click?.();
    expect(actions.showOverlay).toHaveBeenCalledOnce();
    expect(actions.hideOverlay).toHaveBeenCalledOnce();
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();

    controller.destroy();
    expect(tray.destroy).toHaveBeenCalledOnce();
  });
});
