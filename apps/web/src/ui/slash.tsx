/**
 * The bar's sign: a forward slash, as typed (Ctrl /), drawn as the studio's other icons are (lucide's
 * stroke, caps and box). Lucide's own "slash" runs corner to corner, more a strike-through than the key.
 */
export function Slash() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide"
      // (it's a sign: the button or field it's in says what it is)
      aria-hidden="true"
    >
      <path d="M15 4 9 20" />
    </svg>
  );
}
