import { loadJobs } from './actions';
import { JobsList } from './JobsList';

// Jobs monitor: live view of background work (script generation, voice, render,
// primitive deploy) with the ability to cancel a running job. RLS scopes the read.
export default async function JobsPage() {
  const jobs = await loadJobs();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-sm opacity-70">
          Background work across your account. Cancel a running job to stop it and start fresh.
        </p>
      </div>
      <JobsList initial={jobs} />
    </div>
  );
}
