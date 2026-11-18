import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import DeploymentsPage from './deployments-page';

/**
 * What is running where: every code project whose pipeline Renkei built,
 * each environment's running commit, as the pipelines' deploy steps report
 * it, on Bitbucket and GitHub alike.
 */
export default async function Deployments(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl('/deployments'));
  return <DeploymentsPage />;
}
