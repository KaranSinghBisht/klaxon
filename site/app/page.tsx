import { Footer, Nav, Stack } from "@/components/Chrome";
import { Evidence } from "@/components/Evidence";
import { Hero } from "@/components/Hero";
import { How } from "@/components/How";
import { Problem } from "@/components/Problem";
import { Protocol } from "@/components/Protocol";

export default function Home() {
  return (
    <main id="top" className="min-h-screen overflow-x-clip">
      <Nav />
      <Hero />
      <Problem />
      <Protocol />
      <How />
      <Evidence />
      <Stack />
      <Footer />
    </main>
  );
}
