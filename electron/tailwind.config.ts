import type { Config } from 'tailwindcss';

/**
 * 灵枢 V2 — UI 驾驶舱主题 V4 (2026-07-17)
 *
 * 设计语言 V4: 紫色 AI Command Center
 * 主色调: 紫色 #a78bfa (来自用户参考图 C:\Users\test123\Desktop\前端参考图\不错.jpeg)
 *
 * V4 变化:
 *   - 紫色 #a78bfa 提升为主色 (V3 是青色)
 *   - 青色 #67e8f9 降为副色
 *   - 深空背景从蓝黑 (#0a0f1c) 改为紫黑 (#0a0a14)
 *   - 新增发光系列: purpleGlow / purpleSoft / cyanGlow / amberGlow
 *   - 新增动效曲线: spring / breath / data
 *   - 新增字号: micro (10px), 4xl (56px)
 *
 * V3 兼容: 所有旧 token 保留 (Tailwind 不会因为重复 key 报错)
 * 旧 token 保留供 Phase A-C 测试继续通过
 *
 * 关联记忆: ~/.claude/memory/lingshu-cockpit-design-tokens.md
 */
const config: Config = {
  content: ['./src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  // V6 自定义类 safelist (确保 JIT 生成 CSS, 即使动态拼接也生效)
  safelist: [
    'text-v6-accent-cyan', 'text-v6-accent-cyan-bright', 'text-v6-accent-purple', 'text-v6-accent-orange',
    'text-v6-ink-1', 'text-v6-ink-2', 'text-v6-ink-3',
    'bg-v6-bg-0', 'bg-v6-bg-1', 'bg-v6-bg-2', 'bg-v6-bg-3',
    'bg-v6-accent-cyan', 'bg-v6-accent-purple', 'bg-v6-accent-orange',
    'border-v6-border-default', 'border-v6-border-cyan', 'border-v6-border-cyan-strong', 'border-v6-border-purple',
    'ring-v6-accent-cyan', 'ring-v6-accent-purple',
    'shadow-v6-glow-cyan', 'shadow-v6-glow-purple', 'shadow-v6-glow-orange',
    'v6-dot-running', 'v6-dot-done', 'v6-dot-pending', 'v6-dot-error',
    'v6-glass-float', 'v6-glass-card', 'v6-glass-purple',
    'v6-float-window', 'v6-input-bar', 'v6-bottom-beam', 'v6-bg-cosmic',
    'v6-btn-primary', 'v6-btn-purple', 'v6-btn-stop',
    'w-v6-left', 'w-v6-right', 'w-v6-input', 'h-v6-header',
    'text-v6-success', 'text-v6-error', 'text-v6-warning',
    'bg-v6-success', 'bg-v6-error', 'bg-v6-warning',
  ],
  theme: {
    extend: {
      colors: {
        // ─── V3 兼容 token (保留 — Phase A-C 测试用) ───
        // 背景层级 (从深到浅)
        'bg-void': '#050811',       // 最深 — 顶部状态栏/对话外圈
        'bg-base': '#0a0f1c',       // 主背景 — 深空 (V3)
        'bg-card': '#131826',       // 卡片底色
        'bg-elevated': '#1a2032',   // 浮起卡片
        'bg-overlay': '#0f1424',    // 模态遮罩

        // V3 旧主色 — 克制青 (保留但降为副色)
        'accent-cyan': '#4dd0e1',
        'accent-cyan-dim': '#2a7a85',
        'accent-cyan-glow': 'rgba(77, 208, 225, 0.18)',

        // V3 旧辅色 — 软紫 (保留)
        'accent-purple': '#9575cd',  // V3 旧紫,V4 新紫覆盖为主色
        'accent-purple-dim': '#5b4a82',
        'accent-purple-glow': 'rgba(149, 117, 205, 0.18)',

        // ─── V4 新 token (紫色 AI Command Center) ───
        // V4 主色 — 紫色 #a78bfa (亮, 高饱和, 适合发光边框)
        'accent-purple-v4': '#a78bfa',
        'accent-purple-dim-v4': '#7c3aed',
        'accent-purple-glow-v4': 'rgba(167, 139, 250, 0.35)',
        'accent-purple-soft-v4': 'rgba(167, 139, 250, 0.12)',

        // V4 副色 — 青色 (保留并更新)
        'accent-cyan-v4': '#67e8f9',
        'accent-cyan-dim-v4': '#06b6d4',
        'accent-cyan-glow-v4': 'rgba(103, 232, 249, 0.30)',

        // V4 强调色 — 琥珀 (用于警告/重要)
        'accent-amber-v4': '#fbbf24',
        'accent-amber-glow-v4': 'rgba(251, 191, 36, 0.30)',

        // V4 深空背景 — 紫黑 (#0a0a14, 不是蓝黑)
        'bg-base-v4': '#0a0a14',
        'bg-card-v4': '#13111f',
        'bg-elevated-v4': '#1c1830',
        'bg-void-v4': '#050308',

        // 状态色 (V3 保留)
        'accent-blue': '#5b8def',    // 信息
        'accent-green': '#5dd39e',   // 成功
        'accent-orange': '#f4a261',  // 警告 (柔和)
        'accent-red': '#ef6b6b',     // 错误 (柔和)
        'accent-yellow': '#f2d479',  // 提示

        // 文字层级
        'text-primary': '#e8eaf0',
        'text-secondary': '#a3acc2',
        'text-tertiary': '#6b7488',
        'text-disabled': '#4a5366',

        // 边框/分隔
        'border-subtle': 'rgba(139, 148, 178, 0.08)',
        'border-default': 'rgba(139, 148, 178, 0.16)',
        'border-active': 'rgba(77, 208, 225, 0.4)',
        // V4 边框 (紫色发光边框)
        'border-purple-v4': 'rgba(167, 139, 250, 0.30)',
        'border-purple-strong-v4': 'rgba(167, 139, 250, 0.55)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans CJK SC"',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        // V4 微字号 (HUD/标签)
        'micro': ['10px', { lineHeight: '14px', letterSpacing: '0.05em' }],
        '4xl': ['56px', { lineHeight: '64px', letterSpacing: '-0.02em' }],
      },
      animation: {
        // V3 保留
        'pulse-slow': 'pulseSlow 3s ease-in-out infinite',
        'glow': 'glow 2.4s ease-in-out infinite',
        'fade-scale': 'fadeScale 0.2s ease-out',
        'slide-in': 'slideIn 0.3s ease-out',
        'shimmer': 'shimmer 2s linear infinite',
        // V4 新动效
        'breath': 'breath 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'particle-flow': 'particleFlow 3s linear infinite',
        'orbit': 'orbit 8s linear infinite',
        'hud-pulse': 'hudPulse 1.6s ease-in-out infinite',
        'shimmer-purple': 'shimmerPurple 2.5s linear infinite',
      },
      keyframes: {
        // V3 保留
        pulseSlow: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        glow: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(77, 208, 225, 0.18)' },
          '50%': { boxShadow: '0 0 20px rgba(77, 208, 225, 0.4)' },
        },
        fadeScale: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        // V4 新动效
        breath: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.6' },
          '50%': { transform: 'scale(1.04)', opacity: '1' },
        },
        particleFlow: {
          '0%': { offsetDistance: '0%', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { offsetDistance: '100%', opacity: '0' },
        },
        orbit: {
          '0%': { transform: 'rotate(0deg) translateX(40px) rotate(0deg)' },
          '100%': { transform: 'rotate(360deg) translateX(40px) rotate(-360deg)' },
        },
        hudPulse: {
          '0%, 100%': { boxShadow: '0 0 4px rgba(167, 139, 250, 0.4), inset 0 0 4px rgba(167, 139, 250, 0.2)' },
          '50%': { boxShadow: '0 0 12px rgba(167, 139, 250, 0.7), inset 0 0 8px rgba(167, 139, 250, 0.4)' },
        },
        shimmerPurple: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      backdropBlur: {
        glass: '20px',
        cockpit: '32px',
        'glass-cockpit': '24px',
      },
      boxShadow: {
        'glass-card': '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
        'cockpit-panel': '0 12px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(139, 148, 178, 0.08)',
        'glow-cyan': '0 0 20px rgba(77, 208, 225, 0.25)',
        'glow-purple': '0 0 20px rgba(149, 117, 205, 0.25)',
        // V4 新发光 (紫色 AI Command Center)
        'purple-glow': '0 0 24px rgba(167, 139, 250, 0.45), 0 0 48px rgba(167, 139, 250, 0.20)',
        'purple-glow-sm': '0 0 12px rgba(167, 139, 250, 0.40)',
        'purple-soft': '0 0 16px rgba(167, 139, 250, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        'cyan-glow-v4': '0 0 20px rgba(103, 232, 249, 0.35)',
        'amber-glow-v4': '0 0 20px rgba(251, 191, 36, 0.40)',
        'glass-cockpit': '0 8px 32px rgba(167, 139, 250, 0.10), inset 0 1px 0 rgba(167, 139, 250, 0.18), inset 0 -1px 0 rgba(167, 139, 250, 0.05)',
        // V6 新 (差量化设计)
        'v6-glow-cyan': '0 0 16px rgba(77, 208, 225, 0.45)',
        'v6-glow-purple': '0 0 16px rgba(139, 127, 255, 0.45)',
        'v6-glow-orange': '0 0 16px rgba(255, 120, 73, 0.55)',
      },
      transitionTimingFunction: {
        // V4 动效曲线
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        breath: 'cubic-bezier(0.4, 0, 0.6, 1)',
        data: 'cubic-bezier(0.16, 1, 0.3, 1)',
        // V6 动效曲线 (Material 3 + Apple HIG)
        'snap-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'snap-in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      borderRadius: {
        'xl2': '1.25rem',
      },
      // V6 新增 token (设计系统调研后)
      // 8 级字号 (Material 3)
      fontSize: {
        'xs': ['12px', { lineHeight: '16px' }],
        'sm': ['14px', { lineHeight: '20px' }],
        'base': ['15px', { lineHeight: '22px' }],
        'lg': ['18px', { lineHeight: '24px' }],
        'xl': ['22px', { lineHeight: '28px' }],
        '2xl': ['28px', { lineHeight: '34px' }],
        '3xl': ['36px', { lineHeight: '44px' }],
        '4xl': ['48px', { lineHeight: '56px' }],
      },
      // V6 spacing (8px 网格, 6 档)
      spacing: {
        'v6-1': '4px',
        'v6-2': '8px',
        'v6-3': '16px',
        'v6-4': '24px',
        'v6-5': '32px',
        'v6-6': '48px',
      },
      // V6 宽度 (3 段式布局用)
      width: {
        'v6-left': '280px',
        'v6-right': '320px',
        'v6-input': '720px',
      },
      height: {
        'v6-header': '56px',
      },
    },
  },
  plugins: [],
};
export default config;