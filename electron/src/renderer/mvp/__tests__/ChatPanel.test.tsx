import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatPanel from '../ChatPanel';

describe('ChatPanel integration (MVP)', () => {
  beforeEach(() => {
    // 默认 mock /api/providers 返回 mock (避免真实后端依赖)
    global.fetch = vi.fn((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/providers')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              provider: 'mock',
              available: true,
              models: [{ name: 'mock-model', label: 'Mock Model' }],
            },
          ],
        } as Response);
      }
      if (u.includes('/chat/stream')) {
        return Promise.resolve({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const emit = (obj: unknown) =>
                controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
              const text = '灵枢测试回复';
              emit({ type: 'message_start', messageId: 'm1', model: 'ollama', timestamp: 0 });
              let i = 0;
              const send = () => {
                if (i < text.length) {
                  emit({ type: 'text_delta', messageId: 'm1', delta: text[i] });
                  i++;
                  setTimeout(send, 5);
                } else {
                  emit({
                    type: 'message_finish',
                    messageId: 'm1',
                    finishReason: 'stop',
                    timestamp: 0,
                  });
                  controller.close();
                }
              };
              send();
            },
          }),
        } as Response);
      }
      return Promise.reject(new Error(`unmocked ${u}`));
    }) as typeof fetch;
  });

  it('renders chat panel layout (header + session list + input)', () => {
    render(<ChatPanel />);
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    expect(screen.getByText('灵枢')).toBeInTheDocument();
    expect(screen.getByTestId('new-session')).toBeInTheDocument();
    expect(screen.getByTestId('input')).toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeInTheDocument();
  });

  it('user can type, send, and see streamed response', async () => {
    render(<ChatPanel />);
    const inputs = screen.getAllByTestId('input');
    const input = inputs[0];
    fireEvent.change(input, { target: { value: '你好' } });
    const buttons = screen.getAllByTestId('send-button');
    fireEvent.click(buttons[0]);

    await waitFor(
      () => {
        expect(screen.getByText('灵枢测试回复')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});