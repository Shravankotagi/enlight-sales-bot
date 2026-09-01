const { checkRecurringCustomers } = require('./kra3');
const { checkWeeklyVisits } = require('./kra9');
const { checkPayments } = require('./kra5');
const { checkComplaints } = require('./kra8');

function startScheduler() {
  console.log('Scheduler started');
  
  // Run KRA 3 check immediately on startup (for testing)
  // In production this runs at 9 PM daily
  
  // Check every 24 hours
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  
  // Calculate time until next 9 PM IST
  function getNextRunTime() {
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + IST_OFFSET);
    
    const next9PM = new Date(istNow);
    next9PM.setHours(21, 0, 0, 0);
    
    if (istNow.getHours() >= 21) {
      next9PM.setDate(next9PM.getDate() + 1);
    }
    
    return next9PM.getTime() - istNow.getTime();
  }
  
  // Schedule first run
  const timeToFirstRun = getNextRunTime();
  console.log(`Next KRA 3 check in ${Math.round(timeToFirstRun / 1000 / 60)} minutes`);
  
  setTimeout(async () => {
    await checkRecurringCustomers();
    // Then run every 24 hours
    setInterval(checkRecurringCustomers, TWENTY_FOUR_HOURS);
  }, timeToFirstRun);

  // KRA 9 - Weekly visit reminder every Friday at 5 PM IST
  function scheduleWeeklyVisitCheck() {
    function getNextFriday5PM() {
      const now = new Date();
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(now.getTime() + IST_OFFSET);
      
      const day = istNow.getDay();
      const daysUntilFriday = (5 - day + 7) % 7 || 7;
      
      const nextFriday = new Date(istNow);
      nextFriday.setDate(istNow.getDate() + daysUntilFriday);
      nextFriday.setHours(17, 0, 0, 0);
      
      return nextFriday.getTime() - istNow.getTime();
    }

    const msToFriday = getNextFriday5PM();
    console.log(`Next KRA 9 check in ${Math.round(msToFriday / 1000 / 60)} minutes`);
    
    setTimeout(async () => {
      await checkWeeklyVisits();
      setInterval(checkWeeklyVisits, 7 * 24 * 60 * 60 * 1000);
    }, msToFriday);
  }

  scheduleWeeklyVisitCheck();

  // KRA 5 - Payment check twice daily (9 AM and 3 PM IST)
  function schedulePaymentChecks() {
    function msUntilNext(hour) {
      const now = new Date();
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(now.getTime() + IST_OFFSET);
      const next = new Date(istNow);
      next.setHours(hour, 0, 0, 0);
      if (istNow.getHours() >= hour) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime() - istNow.getTime();
    }

    // 9 AM IST check
    setTimeout(async () => {
      await checkPayments();
      setInterval(checkPayments, 24 * 60 * 60 * 1000);
    }, msUntilNext(9));

    // 3 PM IST check
    setTimeout(async () => {
      await checkPayments();
      setInterval(checkPayments, 24 * 60 * 60 * 1000);
    }, msUntilNext(15));

    console.log('Payment checks scheduled: 9 AM and 3 PM IST daily');
  }

  schedulePaymentChecks();

  // KRA 8 - Complaint check every 5 hours
  async function runComplaintCheck() {
    await checkComplaints();
  }

  // Run immediately on startup (throttled persistently in DB to 5 hours) and then every 5 hours
  runComplaintCheck();
  setInterval(runComplaintCheck, 5 * 60 * 60 * 1000);
  console.log('Complaint check scheduled: every 5 hours');
}

// For manual trigger (testing)
async function runNow() {
  console.log('Manual KRA 3 check triggered...');
  await checkRecurringCustomers();
}

module.exports = { startScheduler, runNow };
