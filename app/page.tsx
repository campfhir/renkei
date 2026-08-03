'use client';

import { FormEvent, useState } from 'react';

export default function Home() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        setError('Failed to sign in. Please try again.');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-black px-4">
      <main style={{ maxWidth: '30rem' }} className="w-full">
        <h1 className="text-3xl font-bold mb-2">Sign in to Renkei</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Enter your work email, and we'll find your organization.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-2">
              Work email
            </label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-2 px-4 rounded-lg transition-colors"
          >
            {isLoading ? 'Signing in...' : 'Continue'}
          </button>
        </form>

        <p className="text-sm text-gray-600 dark:text-gray-400 mt-8">
          First time here?{' '}
          <a
            href="/create-organization"
            className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
          >
            Create your organization
          </a>{' '}
          instead.
        </p>

        <p className="text-center text-sm text-gray-500 dark:text-gray-500 mt-12">
          Renkei — Jira work item gateway
        </p>
      </main>
    </div>
  );
}
