import { useNavigate } from "react-router-dom";
import { clearSession } from "../../utils/session";
import { SignOutIcon } from "../Icons/Icons";

export default function SignOutButton() {
  const navigate = useNavigate();

  function signOut() {
    clearSession();
    navigate("/");
  }

  return (
    <button type="button" className="sign-out" onClick={signOut}>
      <SignOutIcon size={16} />
      Sign out
    </button>
  );
}
