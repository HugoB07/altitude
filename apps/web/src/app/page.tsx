import { redirect } from 'next/navigation';

// The application is the product; there is no marketing page yet. Sending
// people straight to /app means the household check decides where they land.
export default function Home() {
  redirect('/app');
}
