import { PassList } from "@/components/PassList";

export default function PassesPage() {
  return (
    <>
      <h1>My passes</h1>
      <p className="lede">The pets the connected wallet owns right now, read from the chain.</p>
      <PassList />
    </>
  );
}
