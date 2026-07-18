import styles from './WelcomeBanner.module.css';

export interface WelcomeBannerProps {
  onOpenSettings: () => void;
  onDismiss: () => void;
  /** settings 加载失败时显示红色错误 banner (覆盖黄色 mock 提示) */
  error?: string | null;
}

export default function WelcomeBanner({ onOpenSettings, onDismiss, error }: WelcomeBannerProps) {
  if (error) {
    return (
      <div className={`${styles.banner} ${styles.error}`}>
        <span>设置加载失败: {error}, 检查后端是否启动</span>
        <button onClick={onOpenSettings}>⚙ 重试</button>
        <button onClick={onDismiss} className={styles.dismiss}>×</button>
      </div>
    );
  }
  return (
    <div className={styles.banner}>
      <span>你还没设 API key, 现在聊的是 mock. 要设就点 ⚙</span>
      <button onClick={onOpenSettings}>⚙ 设置</button>
      <button onClick={onDismiss} className={styles.dismiss}>×</button>
    </div>
  );
}