import React, { useState, useRef } from 'react';
import { useAuth } from '../context/auth-context';
import { useNavigate } from 'react-router-dom';
import { Factory, User as UserIcon, Lock, AlertCircle, Shield } from 'lucide-react';
import ReCAPTCHA from 'react-google-recaptcha';
import { Button, Input, Label, Card } from './ui';

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
        setError('Please complete the CAPTCHA verification');
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
      setError(err instanceof Error ? err.message : 'Login failed');
      if (recaptchaRef.current) {
        recaptchaRef.current.reset();
        setCaptchaToken(null);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-background to-muted px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/30">
            <Factory className="h-8 w-8 text-primary-foreground" />
          </div>
          <h1 className="mt-6 text-3xl font-bold tracking-tight text-foreground">
            Dawlance · LineSentry
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to access your production dashboard
          </p>
          {showCaptcha && (
            <div className="mt-3 inline-flex items-center gap-2 text-xs text-warning">
              <Shield className="h-4 w-4" />
              <span>Security verification required</span>
            </div>
          )}
        </div>

        <Card className="p-8">
          <form className="space-y-5" onSubmit={handleSubmit}>
            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                icon={<UserIcon className="h-5 w-5" />}
              />
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                icon={<Lock className="h-5 w-5" />}
              />
            </div>

            {showCaptcha && (
              <div className="flex justify-center">
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

          {loginAttempts > 0 && (
            <p className="mt-6 text-center text-xs text-muted-foreground">
              Login attempts: {loginAttempts}
              {loginAttempts >= 2 && ' · CAPTCHA required'}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
};

export default Login;
