import React, { useState, useRef } from 'react';
import { useAuth } from '../context/auth-context';
import { useNavigate } from 'react-router-dom';
import { Activity } from 'lucide-react';
import ReCAPTCHA from 'react-google-recaptcha';
import { Button, Field, Input } from './ui';

const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [loginAttempts, setLoginAttempts] = useState(0);
  const { login } = useAuth();
  const navigate = useNavigate();
  const recaptchaRef = useRef<ReCAPTCHA>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Require CAPTCHA once it's been shown (after 2 failed attempts).
    if (loginAttempts >= 2 || showCaptcha) {
      if (!captchaToken) {
        setError('Complete the security check to continue.');
        setLoading(false);
        setShowCaptcha(true);
        return;
      }
    }

    try {
      await login(username, password, captchaToken || undefined);
      navigate('/dashboard');
    } catch (err) {
      const newAttempts = loginAttempts + 1;
      setLoginAttempts(newAttempts);
      if (newAttempts >= 2) setShowCaptcha(true);
      setError(err instanceof Error ? err.message : 'Sign in failed');
      if (recaptchaRef.current) {
        recaptchaRef.current.reset();
        setCaptchaToken(null);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-foreground text-background">
            <Activity className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">LineSentry</span>
        </div>

        <h1 className="mt-8 text-2xl font-semibold leading-8 text-foreground">Sign in</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Use your LineSentry account.</p>

        {error && (
          <p role="alert" className="mt-6 rounded-md border border-destructive/30 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <Field label="Username">
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>

          <Field label="Password">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {showCaptcha && (
            <div>
              <p className="mb-2 text-[13px] text-muted-foreground">
                Security check required. Tick the box below, then sign in.
              </p>
              <ReCAPTCHA
                ref={recaptchaRef}
                sitekey={import.meta.env.VITE_RECAPTCHA_SITE_KEY}
                onChange={setCaptchaToken}
                theme="dark"
              />
            </div>
          )}

          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={loading}
            disabled={loading || (showCaptcha && !captchaToken)}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
};

export default Login;
