import React, { useState } from "react";
import HomePage from "./HomePage";
import Chat from "./Chat";
import AdminPanel from "./AdminPanel";

export default function App() {
  const [showHomePage, setShowHomePage] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);

  const handleGetStarted = () => {
    setShowHomePage(false);
  };

  const handleBackToHome = () => {
    if (window.confirm("Are you sure you want to return to the home page? Any unsaved data will be lost.")) {
      setShowHomePage(true);
    }
  };

  return (
    <div>
      {showAdmin ? (
        <AdminPanel onBack={() => setShowAdmin(false)} />
      ) : showHomePage ? (
        <HomePage
          onGetStarted={handleGetStarted}
          onAdmin={() => setShowAdmin(true)}
        />
      ) : (
        <Chat onBackToHome={handleBackToHome} />
      )}
    </div>
  );
}