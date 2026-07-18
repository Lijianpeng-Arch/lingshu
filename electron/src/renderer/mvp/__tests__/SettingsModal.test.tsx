import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsModal from '../SettingsModal';

describe('SettingsModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/settings') && !u.includes('test-key')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            mode: 'smart',
            rules: [],
            permissionTimeoutSeconds: 60,
            apiKeys: { deepseek: 'sk-test' },
            currentProvider: 'deepseek',
            currentModel: 'deepseek-chat',
            workspaceDir: '/home/test',
            shellCwd: '/home/test',
            availableProviders: ['deepseek', 'ollama'],
          }),
        } as Response);
      }
      if (u.includes('test-key')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, latencyMs: 123 }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }) as any;
  });

  it('renders all 4 section headings when open', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    await waitFor(() => {
      // 用 heading role + level 3 精确定位 h3, 避免 label 文本误匹配
      expect(screen.getByRole('heading', { level: 3, name: /模型选择/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: /API Keys/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: /^📁 工作目录$/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: /权限/ })).toBeInTheDocument();
    });
  });

  it('renders nothing when closed', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('submits PATCH on save button click', async () => {
    const onClose = vi.fn();
    render(<SettingsModal open={true} onClose={onClose} />);
    await waitFor(() => screen.getByRole('heading', { level: 3, name: /模型选择/ }));
    // footer 的"保存"按钮 — 通过 className 区分 (primary)
    const buttons = screen.getAllByRole('button');
    const saveBtn = buttons.find((b) => b.className.includes('primary') && b.textContent === '保存');
    expect(saveBtn).toBeDefined();
    fireEvent.click(saveBtn!);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({ method: 'PATCH' }),
      );
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows test result on 测试连接 click', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByRole('heading', { level: 3, name: /模型选择/ }));
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    fireEvent.click(testBtn);
    await waitFor(() => {
      expect(screen.getByText(/123/)).toBeInTheDocument();
    });
  });
});