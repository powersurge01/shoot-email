import { ingestInboundMessage } from './services.js';

const DEMO_MESSAGES = [
  {
    id: 'DEMO-LANDLORD-LAUNCH-001',
    fromEmail: 'launch-leasing@example.com',
    fromName: 'Jordan at Launch Leasing',
    subject: 'Re: Tour request: Launch in Alameda',
    textBody: [
      'Hi Serguei,',
      '',
      'Thanks for your interest in Launch in Alameda. We can show you the property on Saturday, July 25 at 11:00 AM or 2:30 PM. We also have Sunday, July 26 between noon and 3:00 PM.',
      '',
      'Please reply with the time you prefer. Bring a photo ID and meet us in the main lobby five minutes before the appointment.',
      '',
      'Listing: https://hotpads.com/launch-alameda-ca-94501-249h5r1/pad',
      '',
      'Best,',
      'Jordan',
      'Launch Leasing Team',
    ].join('\n'),
  },
  {
    id: 'DEMO-LANDLORD-PACIFIC-002',
    fromEmail: 'pacific-manager@example.org',
    fromName: 'Priya, Pacific Avenue Manager',
    subject: 'Re: Tour request: 930 Pacific Avenue, Unit 4D',
    textBody: [
      'Hi Serguei,',
      '',
      'Unit 4D at 930 Pacific Avenue is available to tour this weekend. The current resident can accommodate a showing on Sunday, July 26 at 10:30 AM or 1:00 PM. Saturday is not available because we need to provide advance notice.',
      '',
      'Let me know which Sunday time works for you and how many people will attend. You do not need to bring application documents for the tour.',
      '',
      'Listing: https://hotpads.com/930-pacific-ave-alameda-ca-94501-1m7kr0d/4d/pad',
      '',
      'Regards,',
      'Priya',
      'Pacific Avenue Property Manager',
    ].join('\n'),
  },
  {
    id: 'DEMO-LANDLORD-ALAMEDA-PARK-003',
    fromEmail: 'alameda-park-leasing@example.net',
    fromName: 'Elena at Alameda Park Apartments',
    subject: 'Re: Tour request: Alameda Park Apartments',
    textBody: [
      'Hello Serguei,',
      '',
      'We would be happy to show you Alameda Park Apartments. Our weekend openings are Saturday, July 25 at 1:00 PM or 3:00 PM and Sunday, July 26 at 11:00 AM.',
      '',
      'Please tell us which time you would like and whether you have any pets so we can prepare the relevant information. A photo ID is required when you arrive at the leasing office.',
      '',
      'Listing: https://hotpads.com/alameda-park-apartments-alameda-ca-94501-249hcy5/pad',
      '',
      'Thank you,',
      'Elena',
      'Alameda Park Leasing',
    ].join('\n'),
  },
];

export async function seedDemoMailbox(toEmail, now = new Date()) {
  const results = [];
  for (const [index, message] of DEMO_MESSAGES.entries()) {
    results.push(await ingestInboundMessage({
      ...message,
      toEmail,
      providerMessageId: `<${message.id}@demo.shoot-email.local>`,
      receivedAt: new Date(now.getTime() - (DEMO_MESSAGES.length - index) * 60_000),
    }));
  }
  return results;
}
