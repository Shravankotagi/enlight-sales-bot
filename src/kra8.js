const { createClient } = require('@supabase/supabase-js');
const { sendTextMessage } = require('./whatsapp');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Detect if message is a complaint report
function isComplaintReport(text) {
  const complaintKeywords = [
    'complaint', 'complain', 'issue', 'problem',
    'quality issue', 'wrong material', 'wrong quantity',
    'delivery problem', 'billing issue', 'reject', 'rejection',
    'customer unhappy', 'customer angry', 'not satisfied',
    'shikayat', 'problem aaya', 'issue aaya', 'galat material',
    'galat quantity', 'delivery late', 'damage', 'damaged',
    'short delivery', 'excess billing', 'rate issue',
    'size wrong', 'grade wrong', 'material reject'
  ];
  const lower = text.toLowerCase();
  return complaintKeywords.some(k => lower.includes(k));
}

// Detect if message is complaint resolution
function isComplaintResolution(text) {
  const upper = text.toUpperCase().trim();
  return upper.startsWith('RESOLVED ') ||
         upper.startsWith('RESOLVE ') ||
         upper.startsWith('CLOSED ') ||
         upper.startsWith('CLOSE ') ||
         upper.startsWith('FIXED ') ||
         upper.startsWith('FIX ') ||
         upper === 'RESOLVED' ||
         upper === 'RESOLVE' ||
         upper === 'CLOSED' ||
         upper === 'CLOSE';
}

// Extract complaint details using Google Gemini
// Smart regex fallback to extract customer/company name from complaint description
function fallbackExtractCustomerName(text) {
  if (!text) return null;
  const clean = text.trim();
  const m1 = clean.match(/^([A-Za-z0-9\s.&'-]+?)\s+(?:complaint|issue|problem|rejection|galat|reject)/i);
  if (m1 && m1[1] && m1[1].trim().length > 2) {
    const candidate = m1[1].trim();
    if (!['customer', 'client', 'reported', 'new', 'urgent', 'got', 'received', 'the', 'our', 'material'].includes(candidate.toLowerCase())) {
      return candidate;
    }
  }
  const m2 = clean.match(/(?:complaint|issue|problem|rejection)\s+(?:for|from|at|about|of)\s+([A-Za-z0-9\s.&'-]+?)(?:[:,\-]|\s+they|\s+we|\s+material|\s+received|$)/i);
  if (m2 && m2[1] && m2[1].trim().length > 2) {
    const candidate = m2[1].trim();
    if (!['customer', 'client', 'reported', 'new', 'urgent', 'got', 'received', 'the', 'our', 'material'].includes(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

// Extract complaint details using Google Gemini
async function extractComplaintDetails(text) {
  try {
    const { invokeWithFallback } = require('./core/modelRouter');
    const { HumanMessage } = require('@langchain/core/messages');

    const prompt = `
Extract complaint details from this salesperson message.
Return ONLY a JSON object, no markdown, no backticks:

{
  "customer_name": "",
  "complaint_type": "",
  "description": "",
  "severity": ""
}

Rules:
- customer_name: company/client name if mentioned (e.g. "ABC Fabricators"), else null
- complaint_type: one of 
  "quality|quantity|billing|delivery|size|grade|damage|other"
- description: brief description of the complaint
- severity: one of "low|medium|high|critical"
  critical = customer threatening to cancel/leave
  high = material rejected or returned
  medium = issue reported, needs resolution
  low = minor concern
- Return ONLY the JSON object

Message: "${text}"
    `;

    const res = await invokeWithFallback([new HumanMessage(prompt)], null, false);
    const rawText = typeof res?.content === 'string' ? res.content : JSON.stringify(res?.content || '');

    const { safeParseJSON } = require('./utils/jsonUtils');
    const parsed = safeParseJSON(rawText, null);
    if (!parsed) throw new Error('Could not parse complaint details JSON');

    if (!parsed.customer_name || parsed.customer_name === 'null' || parsed.customer_name === 'Unknown') {
      const fallbackName = fallbackExtractCustomerName(text);
      if (fallbackName) {
        parsed.customer_name = fallbackName;
      }
    }

    return parsed;
  } catch (error) {
    console.error('extractComplaintDetails error:', error.message);
    const fallbackName = fallbackExtractCustomerName(text);
    return {
      customer_name: fallbackName,
      complaint_type: 'other',
      description: text,
      severity: 'medium'
    };
  }
}

// Save complaint to database
async function saveComplaint(details, senderPhone) {
  const supabase = getSupabase();
  try {
    const custName = details.customer_name || fallbackExtractCustomerName(details.description) || null;
    const { data, error } = await supabase
      .from('complaints')
      .insert({
        customer_name: custName,
        complaint_type: details.complaint_type,
        description: details.description,
        reported_by: senderPhone,
        reported_at: new Date().toISOString(),
        status: 'pending',
        escalated: false
      })
      .select()
      .single();

    if (error) throw error;
    console.log('Complaint saved:', data.id);
    return data;
  } catch (error) {
    console.error('saveComplaint error:', error.message);
    return null;
  }
}

// Build complaint confirmation message
function buildComplaintConfirmation(details, complaint) {
  const shortId = complaint?.id?.substring(0, 8) || 'N/A';
  const severityEmoji = {
    'low': '🟡',
    'medium': '🟠', 
    'high': '🔴',
    'critical': '🚨'
  }[details.severity] || '🟠';

  const typeEmoji = {
    'quality': '🔍',
    'quantity': '📦',
    'billing': '💰',
    'delivery': '🚚',
    'size': '📏',
    'grade': '⚗️',
    'damage': '💔',
    'other': '❓'
  }[details.complaint_type] || '❓';

  return `${severityEmoji} *Customer Complaint Logged*\n\n` +
    `🏢 Customer: ${details.customer_name || 'Not specified'}\n` +
    `${typeEmoji} Type: ${details.complaint_type}\n` +
    `📝 Description: ${details.description}\n` +
    `⚡ Severity: ${details.severity}\n` +
    `🔖 Ref: ${shortId}\n\n` +
    `⏰ *48-hour resolution timer started*\n\n` +
    `Updated Customer Complaints Card! ✅\n\n` +
    `You will receive reminders at:\n` +
    `• 24 hours - if still open\n` +
    `• 48 hours - escalation to Sales Lead\n\n` +
    `To close: Reply *RESOLVED ${details.customer_name?.split(' ')[0]?.toUpperCase() || 'COMPLAINT'} [resolution details]*`;
}

// Notification throttling state
const notificationThrottleState = {
  managerLastReminded: {}, // { [managerPhone]: timestamp }
  adminLastDigestAt: 0,    // timestamp
  complaintLastReminded: {}, // { [complaintId]: timestamp }
};

// Check pending complaints and send reminders/escalations
async function checkComplaints() {
  const supabase = getSupabase();
  try {
    console.log('Running Customer Complaints check...');

    // STRICT QUERY: ONLY OPEN COMPLAINTS
    // Status MUST NOT be 'resolved' or 'closed' and resolved_at MUST be null
    const { data: openComplaints, error } = await supabase
      .from('complaints')
      .select('*')
      .not('status', 'in', '("resolved","closed")')
      .is('resolved_at', null)
      .order('reported_at', { ascending: true });

    if (error) throw error;
    if (!openComplaints || openComplaints.length === 0) {
      console.log('No open complaints found');
      return;
    }

    console.log(`Checking ${openComplaints.length} open complaints...`);
    const now = Date.now();
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    const FIVE_HOURS_AGO_ISO = new Date(now - FIVE_HOURS_MS).toISOString();

    // Query recent complaint reminder logs from kra_logs (persistent across server restarts)
    const { data: recentLogs } = await supabase
      .from('kra_logs')
      .select('description, salesperson_phone, kra_type, created_at')
      .eq('kra_number', 8)
      .in('kra_type', ['complaint_reminder', 'complaint_team_reminder', 'complaint_admin_digest'])
      .gte('created_at', FIVE_HOURS_AGO_ISO);

    const recentlyRemindedComplaints = new Set(
      (recentLogs || [])
        .filter(l => l.kra_type === 'complaint_reminder')
        .map(l => String(l.description || ''))
    );

    const recentlyRemindedManagers = new Set(
      (recentLogs || [])
        .filter(l => l.kra_type === 'complaint_team_reminder')
        .map(l => String(l.salesperson_phone || ''))
    );

    const adminDigestRecentlySent = (recentLogs || []).some(l => l.kra_type === 'complaint_admin_digest');

    // Fetch all employees to identify Sales Managers and Admins and their team mappings
    const { data: employees } = await supabase
      .from('employees')
      .select('id, name, phone, role, manager_id');

    const empList = employees || [];
    const admins = empList.filter(e => e.role === 'admin' && e.phone);
    const managers = empList.filter(e => (e.role === 'sales_manager' || e.role === 'manager') && e.phone);

    // Map salespersons to managers
    const managerTeamMap = {};
    managers.forEach(m => {
      const teamSalespersonPhones = empList.filter(e => e.manager_id === m.id).map(e => e.phone).filter(Boolean);
      managerTeamMap[m.phone] = Array.from(new Set([m.phone, ...teamSalespersonPhones]));
    });

    // ────────────────────────────────────────────────────────────────────────
    // 1. SALES MANAGER REMINDERS (AFTER EVERY 5 HOURS)
    // ────────────────────────────────────────────────────────────────────────
    for (const manager of managers) {
      const teamPhones = managerTeamMap[manager.phone] || [manager.phone];
      const teamComplaints = openComplaints.filter(c => teamPhones.includes(c.reported_by));

      if (teamComplaints.length > 0) {
        if (!recentlyRemindedManagers.has(manager.phone)) {
          const count = teamComplaints.length;
          let managerMsg = `⚠️ *Customer Complaints Reminder - Team Alert*\n\n` +
            `Hello ${manager.name || 'Sales Manager'},\n` +
            `You have *${count} open complaint${count > 1 ? 's' : ''}* pending resolution in your sales team:\n\n`;

          teamComplaints.forEach((c, idx) => {
            const reportedAt = new Date(c.reported_at);
            const hrsOpen = Math.max(0, Math.round((now - reportedAt.getTime()) / (1000 * 60 * 60)));
            const hoursLeft = Math.max(0, 48 - hrsOpen);
            const repEmp = empList.find(e => e.phone === c.reported_by);
            const repName = repEmp ? repEmp.name : (c.reported_by || 'Salesperson');

            managerMsg += `${idx + 1}️⃣ *${c.customer_name || 'Customer'}* (Type: ${c.complaint_type || 'General'})\n` +
              `📝 ${c.description}\n` +
              `👤 Reported by: ${repName} (${c.reported_by})\n` +
              `⏰ Open for: *${hrsOpen}h* ${hrsOpen >= 48 ? '🚨 *(SLA BREACHED)*' : `(⏰ ${hoursLeft}h until SLA breach)`}\n\n`;
          });

          managerMsg += `💡 *Action Required:* Please follow up with your team to resolve these complaints within the 48-hour SLA.\n` +
            `Salesperson can reply *RESOLVED [Customer] [resolution]* on WhatsApp or mark resolved on the web dashboard.`;

          await sendTextMessage(manager.phone, managerMsg);
          await supabase.from('kra_logs').insert({
            salesperson_phone: manager.phone,
            kra_number: 8,
            kra_type: 'complaint_team_reminder',
            description: `Team reminder for ${count} open complaints`,
            customer_name: teamComplaints[0]?.customer_name || null,
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear(),
            created_at: new Date().toISOString(),
          });
          recentlyRemindedManagers.add(manager.phone);
          notificationThrottleState.managerLastReminded[manager.phone] = now;
          console.log(`[Complaints Notification] 5-hour team reminder sent to Sales Manager ${manager.name} (${manager.phone}) for ${count} complaints`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          console.log(`[Complaints Notification] Skipping manager ${manager.name} - already reminded within the last 5 hours`);
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. ADMIN REMINDER (ONLY 1 REMINDER A DAY FOR ALL OPEN COMPLAINTS)
    // ────────────────────────────────────────────────────────────────────────
    if (!adminDigestRecentlySent && admins.length > 0 && openComplaints.length > 0) {
      const totalOpen = openComplaints.length;
      let adminMsg = `⚠️ *Daily Customer Complaints Digest - Enlight Metals*\n\n` +
        `There are currently *${totalOpen} unresolved complaint${totalOpen > 1 ? 's' : ''}* across all sales teams:\n\n`;

      openComplaints.forEach((c, idx) => {
        const reportedAt = new Date(c.reported_at);
        const hrsOpen = Math.max(0, Math.round((now - reportedAt.getTime()) / (1000 * 60 * 60)));
        const repEmp = empList.find(e => e.phone === c.reported_by);
        const repName = repEmp ? repEmp.name : (c.reported_by || 'Salesperson');

        adminMsg += `${idx + 1}️⃣ *${c.customer_name || 'Customer'}* (Type: ${c.complaint_type || 'General'})\n` +
          `📝 ${c.description}\n` +
          `👤 Salesperson: ${repName}\n` +
          `⏰ Open for: *${hrsOpen}h* ${hrsOpen >= 48 ? '🚨 *(Escalated / Overdue)*' : '⏳ (Within 48h SLA)'}\n\n`;
      });

      adminMsg += `📊 Full details and status updates are available on the Enlight Sales Dashboard.`;

      for (const admin of admins) {
        await sendTextMessage(admin.phone, adminMsg);
        await supabase.from('kra_logs').insert({
          salesperson_phone: admin.phone,
          kra_number: 8,
          kra_type: 'complaint_admin_digest',
          description: `Daily complaints digest for ${totalOpen} complaints`,
          customer_name: null,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });
        console.log(`[Complaints Notification] Daily 24h digest sent to Admin ${admin.name} (${admin.phone})`);
        await new Promise(r => setTimeout(r, 1000));
      }

      notificationThrottleState.adminLastDigestAt = now;
    } else if (openComplaints.length > 0) {
      console.log(`[Complaints Notification] Skipping Admin daily digest - already sent recently`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3. INDIVIDUAL SALESPERSON 24H REMINDER & 48H ESCALATION (EVERY 5 HOURS)
    // ────────────────────────────────────────────────────────────────────────
    for (const complaint of openComplaints) {
      const reportedAt = new Date(complaint.reported_at);
      const hoursElapsed = (now - reportedAt.getTime()) / (1000 * 60 * 60);
      const salespersonPhone = complaint.reported_by;
      if (!salespersonPhone) continue;

      // 48+ hours - Escalate ONCE
      if (hoursElapsed >= 48 && !complaint.escalated) {
        await supabase
          .from('complaints')
          .update({ escalated: true })
          .eq('id', complaint.id);

        const salespersonMsg =
          `🚨 *Customer Complaint Escalated*\n\n` +
          `Complaint ref: ${complaint.id.substring(0, 8)}\n` +
          `Customer: ${complaint.customer_name || 'Unknown'}\n` +
          `Type: ${complaint.complaint_type}\n` +
          `Hours open: ${Math.round(hoursElapsed)}h\n\n` +
          `⚠️ This has exceeded the 48-hour SLA and has been escalated to Management.\n` +
          `Please resolve immediately and reply:\n` +
          `*RESOLVED ${complaint.customer_name?.split(' ')[0]?.toUpperCase() || 'COMPLAINT'} [resolution]*`;

        await sendTextMessage(salespersonPhone, salespersonMsg);
        await supabase.from('kra_logs').insert({
          salesperson_phone: salespersonPhone,
          kra_number: 8,
          kra_type: 'complaint_escalation',
          description: complaint.id,
          customer_name: complaint.customer_name,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });
        notificationThrottleState.complaintLastReminded[complaint.id] = now;
        console.log(`[Complaints Notification] Escalation notice sent to salesperson for complaint ${complaint.id}`);
        await new Promise(r => setTimeout(r, 1000));

      // 24+ hours - Send reminder to salesperson (cooldown strictly 5 hours via kra_logs)
      } else if (hoursElapsed >= 24 && hoursElapsed < 48) {
        if (!recentlyRemindedComplaints.has(complaint.id)) {
          const reminderMsg =
            `⚠️ *Customer Complaint Reminder*\n\n` +
            `Complaint open for ${Math.round(hoursElapsed)} hours:\n\n` +
            `Customer: ${complaint.customer_name || 'Unknown'}\n` +
            `Type: ${complaint.complaint_type}\n` +
            `Description: ${complaint.description}\n\n` +
            `⏰ ${Math.max(0, Math.round(48 - hoursElapsed))} hours until escalation\n\n` +
            `Resolve and reply:\n` +
            `*RESOLVED ${complaint.customer_name?.split(' ')[0]?.toUpperCase() || 'COMPLAINT'} [resolution]*`;

          await sendTextMessage(salespersonPhone, reminderMsg);
          await supabase.from('kra_logs').insert({
            salesperson_phone: salespersonPhone,
            kra_number: 8,
            kra_type: 'complaint_reminder',
            description: complaint.id,
            customer_name: complaint.customer_name,
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear(),
            created_at: new Date().toISOString(),
          });
          recentlyRemindedComplaints.add(complaint.id);
          notificationThrottleState.complaintLastReminded[complaint.id] = now;
          console.log(`[Complaints Notification] 5-hour reminder sent to salesperson for complaint ${complaint.id}`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          console.log(`[Complaints Notification] Skipping complaint ${complaint.id} - already reminded within the last 5 hours`);
        }
      }
    }

    console.log('Customer complaints check complete');
  } catch (error) {
    console.error('checkComplaints error:', error.message);
  }
}

// Handle complaint log from webhook
async function handleComplaintLog(text, senderPhone) {
  try {
    console.log('Complaint detected:', text);

    const details = await extractComplaintDetails(text);
    console.log('Complaint details:', JSON.stringify(details, null, 2));

    const complaint = await saveComplaint(details, senderPhone);

    // Log to KRA 8
    const supabase = getSupabase();
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 8,
      kra_type: 'complaint_logged',
      description: `${details.complaint_type} complaint: ${details.description}`,
      customer_name: details.customer_name,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });

    // If it's a product rejection, ALSO log to KRA 7 (Zero Rejection)
    const lowerText = text.toLowerCase();
    if (lowerText.includes('reject') || lowerText.includes('rejection')) {
      console.log('Logging rejection to KRA 7 for customer:', details.customer_name);
      await supabase.from('kra_logs').insert({
        salesperson_phone: senderPhone,
        kra_number: 7,
        kra_type: 'rejection',
        description: `Product rejection: ${details.description}`,
        customer_name: details.customer_name,
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear()
      });
    }

    return buildComplaintConfirmation(details, complaint);
  } catch (error) {
    console.error('handleComplaintLog error:', error.message);
    return '❌ Could not log complaint. Please try again.';
  }
}

// Handle complaint resolution reply
async function handleComplaintResolution(text, senderPhone) {
  const supabase = getSupabase();
  try {
    const upper = text.toUpperCase().trim();
    const resolutionActions = ['RESOLVED', 'RESOLVE', 'CLOSED', 'CLOSE', 'FIXED', 'FIX'];
    const matchedAction = resolutionActions.find(a => upper.startsWith(a)) || 'RESOLVED';

    // 1. Fetch all OPEN complaints for this salesperson
    const { data: openComplaints } = await supabase
      .from('complaints')
      .select('*')
      .eq('reported_by', senderPhone)
      .not('status', 'in', '("resolved","closed")')
      .is('resolved_at', null)
      .order('reported_at', { ascending: false });

    let complaint = null;
    let customerKeyword = '';
    let resolution = '';

    if (openComplaints && openComplaints.length > 0) {
      // Find a complaint whose customer name or description matches keywords in the text
      complaint = openComplaints.find(c => {
        if (c.customer_name) {
          const nameLower = c.customer_name.toLowerCase();
          if (text.toLowerCase().includes(nameLower)) return true;
          const words = nameLower.split(/\s+/);
          if (words.some(word => word.length > 3 && text.toLowerCase().includes(word))) return true;
        }
        if (c.description) {
          const descWords = c.description.toLowerCase().split(/[\s,:-]+/);
          if (descWords.some(w => w.length > 4 && text.toLowerCase().includes(w))) return true;
        }
        return false;
      });

      // Fuzzy match fallback using Gemini if no literal match is found
      if (!complaint) {
        console.log('No literal complaint customer match, trying fuzzy matching...');
        const { fuzzyMatchCustomer } = require('./supabase');
        const customerList = openComplaints.map(c => c.customer_name).filter(Boolean);
        if (customerList.length > 0) {
          const matchedName = await fuzzyMatchCustomer(text, customerList);
          if (matchedName) {
            console.log(`Fuzzy matched complaint customer: ${matchedName}`);
            complaint = openComplaints.find(c => c.customer_name === matchedName);
          }
        }
      }

      // If only 1 open complaint exists for this salesperson, match it directly!
      if (!complaint && openComplaints.length === 1) {
        complaint = openComplaints[0];
      }
    }

    if (complaint) {
      customerKeyword = complaint.customer_name || fallbackExtractCustomerName(complaint.description) || 'Customer';
      let tempResolution = text;
      const regexAction = new RegExp(`^${matchedAction}\\s*(complaint|issue|problem|ticket)*\\s*(for|about|of|on)*\\s*`, 'i');
      tempResolution = tempResolution.replace(regexAction, '');
      
      if (complaint.customer_name && tempResolution.toLowerCase().includes(complaint.customer_name.toLowerCase())) {
        tempResolution = tempResolution.replace(new RegExp(complaint.customer_name, 'gi'), '');
      }
      resolution = tempResolution.replace(/^[\s:,\-]+/, '').trim() || 'Resolved';
    } else {
      // FALLBACK: Clean action and filler words to extract customer keyword and resolution
      let cleanText = text;
      const regexPrefix = /^(resolved complaint for|resolve complaint for|resolved complaint|resolve complaint|resolved for|resolve for|resolved|resolve|closed|close|fixed|fix)\s+/i;
      cleanText = cleanText.replace(regexPrefix, '');
      cleanText = cleanText.replace(/^(customer|client|company)\s+/i, '');

      const parts = cleanText.split(/[\s:,\-]+/);
      customerKeyword = parts[0] || '';
      resolution = cleanText.replace(new RegExp(`^${customerKeyword}`, 'i'), '').replace(/^[\s:,\-]+/, '').trim() || 'Resolved';

      if (customerKeyword && customerKeyword.length > 2) {
        const { data: complaints } = await supabase
          .from('complaints')
          .select('*')
          .eq('reported_by', senderPhone)
          .not('status', 'in', '("resolved","closed")')
          .is('resolved_at', null)
          .or(`customer_name.ilike.%${customerKeyword}%,description.ilike.%${customerKeyword}%`)
          .order('reported_at', { ascending: false })
          .limit(1);
        complaint = complaints?.[0];
      }
    }

    if (!complaint) {
      console.log(`No active open complaint found for customer keyword: ${customerKeyword}`);
      return `⚠️ *Resolution Update Declined*\n\nCould not find an active open complaint matching *"${customerKeyword || 'this customer'}"*.\n\nPlease check the dashboard to verify the customer name or if the complaint was already marked as resolved.`;
    }

    const reportedAt = new Date(complaint.reported_at);
    const resolvedAt = new Date();
    const resolutionHrs = Math.round(
      (resolvedAt - reportedAt) / (1000 * 60 * 60)
    );

    const resolvedCustomerName = complaint.customer_name || fallbackExtractCustomerName(complaint.description) || customerKeyword || 'Customer';

    // Mark the matched complaint resolved
    await supabase
      .from('complaints')
      .update({
        customer_name: resolvedCustomerName,
        status: 'resolved',
        resolved_at: resolvedAt.toISOString(),
        resolution_time_hrs: resolutionHrs
      })
      .eq('id', complaint.id);

    // Also resolve any other open duplicates for this customer and salesperson
    if (resolvedCustomerName && resolvedCustomerName !== 'Customer') {
      await supabase
        .from('complaints')
        .update({
          customer_name: resolvedCustomerName,
          status: 'resolved',
          resolved_at: resolvedAt.toISOString(),
          resolution_time_hrs: resolutionHrs
        })
        .eq('reported_by', senderPhone)
        .not('status', 'in', '("resolved","closed")')
        .is('resolved_at', null)
        .or(`customer_name.ilike.%${resolvedCustomerName}%,description.ilike.%${resolvedCustomerName}%`);
    }

    // Log to KRA 8
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 8,
      kra_type: 'complaint_resolved',
      description: `Resolved in ${resolutionHrs}h: ${resolution}`,
      customer_name: resolvedCustomerName,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });

    const withinTarget = resolutionHrs <= 48;
    return `✅ *Complaint Resolved*\n\n` +
      `Customer: ${resolvedCustomerName}\n` +
      `Resolution: ${resolution}\n` +
      `Time taken: ${resolutionHrs} hours\n` +
      `${withinTarget ? '✅ Within 48-hour target!' : '⚠️ Exceeded 48-hour target'}\n\n` +
      `Updated Customer Complaints Card! ✅`;
  } catch (error) {
    console.error('handleComplaintResolution error:', error.message);
    return '❌ Could not log resolution. Please try again.';
  }
}

// Get complaint summary for query
async function getComplaintSummary(scopeOrPhone) {
  const supabase = getSupabase();
  try {
    const { getAccessibleSalespersonPhonesForBot } = require('./supabase');
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '📊 *Customer Complaints Card*\n\n✅ No complaints logged. You currently have no salespersons assigned to your team.';
    }

    const now = new Date();
    const monthStart = new Date(
      now.getFullYear(), now.getMonth(), 1
    ).toISOString();

    let query = supabase
      .from('complaints')
      .select('*')
      .gte('reported_at', monthStart)
      .order('reported_at', { ascending: false });

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        query = query.eq('reported_by', scope.phones[0]);
      } else {
        query = query.in('reported_by', scope.phones);
      }
    }

    const { data: complaints } = await query;

    if (!complaints || complaints.length === 0) {
      return '✅ No complaints logged this month!';
    }

    const pending = complaints.filter(c => c.status === 'pending');
    const resolved = complaints.filter(c => c.status === 'resolved');
    const escalated = complaints.filter(c => c.escalated);

    const avgResolutionTime = resolved.length > 0
      ? Math.round(
          resolved.reduce((sum, c) => sum + (c.resolution_time_hrs || 0), 0) 
          / resolved.length
        )
      : null;

    const title = scope.isAdmin ? 'Company Complaint Summary' : (scope.isManager ? 'Team Complaint Summary' : 'Complaint Summary');
    let msg = `📊 *Customer Complaints Card - ${title}*\n\n` +
      `Total this month: ${complaints.length}\n` +
      `✅ Resolved: ${resolved.length}\n` +
      `⏳ Pending: ${pending.length}\n` +
      `🚨 Escalated: ${escalated.length}\n`;

    if (avgResolutionTime !== null) {
      msg += `⏱️ Avg resolution: ${avgResolutionTime}h\n`;
      msg += `${avgResolutionTime <= 48 ? '✅ Within KRA target' : '⚠️ Above 48h target'}\n`;
    }

    if (pending.length > 0) {
      msg += `\n*Open complaints:*\n`;
      pending.slice(0, 3).forEach(c => {
        const hrs = Math.round(
          (now - new Date(c.reported_at)) / (1000 * 60 * 60)
        );
        msg += `• ${c.customer_name || 'Unknown'} - ${c.complaint_type} (${hrs}h open)\n`;
      });
    }

    return msg;
  } catch (error) {
    console.error('getComplaintSummary error:', error.message);
    return '❌ Could not fetch complaint summary.';
  }
}

module.exports = {
  isComplaintReport,
  isComplaintResolution,
  handleComplaintLog,
  handleComplaintResolution,
  checkComplaints,
  getComplaintSummary,
  extractComplaintDetails,
  fallbackExtractCustomerName,
};
