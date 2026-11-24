import { redirect } from 'next/navigation';

/**
 * Deployments was a section of its own; what a project deploys, and where,
 * is now on each code project's Environments page. Old links land on Code.
 */
export default function MovedToCode(): never {
  redirect('/code');
}
