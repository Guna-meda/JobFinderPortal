// The sender's background, used for outreach drafts. These are the ONLY facts about the sender that a draft
// may state: edit this file if they change, and add nothing that isn't true.
export const BACKGROUND = {
  identity: 'software engineering student',
  experience: 'a software engineering internship at eGov Foundation, working on the DIGIT public-service platform',
  project:
    'Remore, an AI-powered WhatsApp assistant built with Node.js, Express, MongoDB, OpenAI, Twilio, MCP/tool calling and calendar integration',
  interests: 'backend engineering, AI engineering, agent infrastructure and practical product engineering',
};

export const PURPOSES = [
  { key: 'internship_inquiry', label: 'Internship inquiry', needs: ['companyContext'] },
  { key: 'role_application', label: 'Role application', needs: ['role', 'companyContext'] },
  { key: 'recruiter_follow_up', label: 'Recruiter follow-up', needs: ['role', 'appliedDate'] },
  { key: 'job_listing_response', label: 'Response to a job listing', needs: ['role', 'companyContext'] },
];
