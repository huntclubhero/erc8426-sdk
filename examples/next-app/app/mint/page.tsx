import { MintPanel } from "@/components/MintPanel";

export default function MintPage() {
  return (
    <>
      <h1>Hatch a pet</h1>
      <p className="lede">
        Every pet is an ERC-721 token on the <code>PetPass</code> contract. It has three needs; if any goes unmet for too long it lapses. Its wallet pass shows how it is doing and carries links to care for it.
      </p>
      <MintPanel />
    </>
  );
}
