import React from "react";
import "./homepage.css";

export default function HomePage({ onGetStarted, onAdmin }) {
  return (
    <div className="homepage-container">
      <div className="homepage-content">
        {/* Logo Section */}
        <div className="logo-section">
          {/* Replace this div with your actual logo image */}
          <div className="logo-placeholder">
            <h1>TB Guidance Assistant</h1>
          </div>
        </div>

        {/* Description Section */}
        <div className="description-section">
          <h2>Welcome to the TB Public-Health Guidance Assistant</h2>
          <p>
            Ask questions about tuberculosis guidance. Responses use the indexed knowledge sources
            and cite supporting passages when available.
          </p>
        </div>

        {/* Get Started Button */}
        <button className="get-started-btn" onClick={onGetStarted}>
          Get Started
        </button>
        {onAdmin && (
          <button className="admin-entry-btn" onClick={onAdmin}>
            Admin
          </button>
        )}

        {/* Resources Section */}
        <div className="resources-section">
          <h3>Additional Resources</h3>
          <div className="resources-list">
            <div className="resource-item">
              <a href="https://academic.oup.com/cid/advance-article/doi/10.1093/cid/ciae199/7649400?login=false" target="_blank" rel="noopener noreferrer">
              <h4>NTCA Guidelines</h4>
              </a>
              <p>National Tuberculosis Coalition of America Guidelines for Respiratory Isolation and Restrictions to Reduce Transmission of Pulmonary Tuberculosis in Community Settings</p>
              <a href="https://academic.oup.com/cid/advance-article/doi/10.1093/cid/ciae199/7649400?login=false" target="_blank" rel="noopener noreferrer">Learn More →</a>
            </div>

            <div className="resource-item">
              <a href="https://academic.oup.com/jid/article/231/1/31/7814557?login=false" target="_blank" rel="noopener noreferrer">
                <h4>The Journal of Infectious Diseases</h4>
              </a>
              <p>Rights-Based Legal Considerations for Tuberculosis Isolation Practices in Community Settings in the Postpandemic Era</p>
              <a href="https://academic.oup.com/jid/article/231/1/31/7814557?login=false" target="_blank" rel="noopener noreferrer">Learn More →</a>
            </div>

            <div className="resource-item">
              <a href="https://academic.oup.com/jid/issue/231/1" target="_blank" rel="noopener noreferrer">
                <h4>The Journal of Infectious Diseases</h4>
              </a>
              <p>Special Collection on TB Isolation</p>
              <a href="https://academic.oup.com/jid/issue/231/1" target="_blank" rel="noopener noreferrer">Learn More →</a>
            </div>
            
            <div className="resource-item">
              <a href="https://tbcenter.jhu.edu/trac/" target="_blank" rel="noopener noreferrer">
                <h4>Johns Hopkins Medicine TB Research Advancement Center</h4>
              </a>
              <p>Johns Hopkins Tuberculosis Research Advancement Center (TRAC)</p>
              <a href="https://tbcenter.jhu.edu/trac/" target="_blank" rel="noopener noreferrer">Learn More →</a>
            </div>
            
            <div className="resource-item">
              <a href="https://rutgers.idcrowd.org/Account/Login" target="_blank" rel="noopener noreferrer">
                <h4>Global TB Institute: TB Consultation</h4>
              </a>
              <p>Accessible TB Consultation based on location</p>
              <a href="https://rutgers.idcrowd.org/Account/Login" target="_blank" rel="noopener noreferrer">Learn More →</a>
            </div>
            
          </div>
        </div>

        {/* Footer */}
        <div className="homepage-footer">
          <p>© 2024 TB Isolation Assistant. For educational purposes only.</p>
        </div>
      </div>
    </div>
  );
}
