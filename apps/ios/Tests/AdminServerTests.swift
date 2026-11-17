import XCTest
@testable import Atelier

/// What the app sends and how it reads what the server answers, for the four admin server pages: Users, Limits, Server, Activity.
@MainActor final class AdminServerTests: XCTestCase {
    private func json(_ text: String) -> JSON { try! JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    // MARK: - People

    func testPersonParsingAndStatus() {
        let temporary = AdminPerson(json(#"{"id":"u2","username":"member","name":"Mia Member","role":"user","avatar":null,"mustChangePassword":true,"hasPassword":true,"disabled":false,"safeguards":"on","createdAt":1794908939513,"lastActiveAt":null}"#))
        XCTAssertEqual(temporary.role, .user)
        XCTAssertEqual(temporary.status, .temporaryPassword)
        XCTAssertEqual(temporary.safeguards, .on)
        XCTAssertEqual(temporary.activity, "Never signed in")
        XCTAssertFalse(temporary.hasOwnLimits)
        XCTAssertTrue(temporary.passwordState.hasPrefix("Temporary"))

        let disabled = AdminPerson(json(#"{"id":"u3","username":"leo","name":"","role":"user","mustChangePassword":true,"hasPassword":false,"disabled":true,"safeguards":"inherit","createdAt":1,"lastActiveAt":1794908939513}"#))
        XCTAssertEqual(disabled.status, .disabled, "disabled outranks a temporary password")
        XCTAssertEqual(disabled.name, "leo", "an empty name falls back to the username")
        XCTAssertTrue(disabled.passwordState.hasPrefix("None"))
        XCTAssertTrue(disabled.activity.hasPrefix("Active"))

        let own = AdminPerson(json(#"{"id":"u4","username":"a","name":"A","role":"admin","limits":{"tokensPerDay":500000,"requestsPerHour":null},"mustChangePassword":false,"hasPassword":true,"disabled":false,"safeguards":"off"}"#))
        XCTAssertTrue(own.hasOwnLimits)
        XCTAssertFalse(own.isExempt)
        let exempt = AdminPerson(json(#"{"id":"u5","username":"b","name":"B","role":"user","limits":{"exempt":true},"mustChangePassword":false,"hasPassword":true,"disabled":false,"safeguards":"inherit"}"#))
        XCTAssertTrue(exempt.isExempt)
        let nothing = AdminPerson(json(#"{"id":"u6","username":"c","name":"C","role":"user","limits":{"exempt":false},"mustChangePassword":false,"hasPassword":true,"disabled":false,"safeguards":"inherit"}"#))
        XCTAssertFalse(nothing.hasOwnLimits, "an override with nothing set is no override")
    }

    func testMembersAreAdminsFirstThenByNameAndRequestsWaitApart() {
        let all = ["Zed:user", "Anna:admin", "Bea:user", "Priya:pending", "Tom:pending"].enumerated().map { index, text -> AdminPerson in
            let parts = text.split(separator: ":").map(String.init)
            return AdminPerson(json(#"{"id":"\#(index)","username":"\#(parts[0].lowercased())","name":"\#(parts[0])","role":"\#(parts[1])","createdAt":\#(1000 + index)}"#))
        }
        XCTAssertEqual(AdminPeople.members(all).map(\.name), ["Anna", "Bea", "Zed"])
        XCTAssertEqual(AdminPeople.waiting(all).map(\.name), ["Tom", "Priya"], "newest request first")
    }

    func testUsernameRules() {
        XCTAssertTrue(AdminUsername.isValid("mia.member"))
        XCTAssertTrue(AdminUsername.isValid("a1"))
        XCTAssertFalse(AdminUsername.isValid("a"))
        XCTAssertFalse(AdminUsername.isValid(".mia"))
        XCTAssertFalse(AdminUsername.isValid("Mia"))
        XCTAssertFalse(AdminUsername.isValid("mia member"))
        XCTAssertFalse(AdminUsername.isValid(String(repeating: "a", count: 33)))
        XCTAssertEqual(AdminUsername.normalized("  Mia.Member "), "mia.member")
        XCTAssertNil(AdminUsername.problem(""))
        XCTAssertNil(AdminUsername.problem("mia"))
        XCTAssertEqual(AdminUsername.problem("m"), "Use at least 2 characters.")
        XCTAssertNotNil(AdminUsername.problem("mia!"))
        XCTAssertEqual(AdminUsername.suggest(from: "Mia Member"), "mia.member")
        XCTAssertEqual(AdminUsername.suggest(from: "  José  Ångström "), "jose.angstrom")
        XCTAssertEqual(AdminUsername.suggest(from: "Anna-Lena O'Neil"), "anna-lena.oneil")
        XCTAssertEqual(AdminUsername.suggest(from: ""), "")
        XCTAssertLessThanOrEqual(AdminUsername.suggest(from: String(repeating: "abc ", count: 30)).count, 32)
    }

    // MARK: - Invites

    func testInviteStatesAndWords() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func invite(_ expires: Double, used: Double? = nil, by: String? = nil, hint: String? = "9BJY") -> AdminInvite {
            AdminInvite(json(#"{"id":"i","role":"admin","hint":\#(hint.map { "\"\($0)\"" } ?? "null"),"createdAt":1,"expiresAt":\#(expires * 1000),"usedAt":\#(used.map { String($0 * 1000) } ?? "null"),"usedBy":\#(by.map { "\"\($0)\"" } ?? "null")}"#))
        }
        XCTAssertEqual(invite(1_800_000_000 + 86400).state(now: now), .open)
        XCTAssertEqual(invite(1_800_000_000 - 1).state(now: now), .expired)
        XCTAssertEqual(invite(1_800_000_000 + 86400, used: 1_799_000_000, by: "u1").state(now: now), .used)
        XCTAssertEqual(invite(1).maskedCode, "••••-••••-••••-9BJY")
        XCTAssertEqual(invite(1, hint: nil).maskedCode, "Invite link")
        let people = [AdminPerson(json(#"{"id":"u1","username":"mia","name":"Mia Member","role":"user"}"#))]
        XCTAssertTrue(invite(1_799_000_000, used: 1_799_000_000, by: "u1").detail(now: now, people: people).hasPrefix("Used by Mia Member on "))
        XCTAssertTrue(invite(1_799_000_000, used: 1_799_000_000, by: "gone").detail(now: now, people: people).hasPrefix("Used by a person who has since been deleted"))
        XCTAssertTrue(invite(1_700_000_000).detail(now: now, people: people).hasPrefix("Expired on "))
        XCTAssertTrue(invite(1_800_000_000 + 86400 * 3).detail(now: now, people: people).hasPrefix("Admin, expires "))
    }

    func testInviteCodesAndLinks() {
        XCTAssertEqual(AdminInviteCode.normalize("267n-2wsh-sp99-9bjy"), "267N2WSHSP999BJY")
        XCTAssertEqual(AdminInviteCode.normalize(" 267N 2WSH SP99 9BJY "), "267N2WSHSP999BJY")
        XCTAssertEqual(AdminInviteCode.normalize("OOOO-IIII-LLLL-1111"), "0000111111111111", "O is 0, I and L are 1")
        XCTAssertNil(AdminInviteCode.normalize("267N-2WSH-SP99"))
        XCTAssertNil(AdminInviteCode.normalize("UUUU-UUUU-UUUU-UUUU"), "U is not in the alphabet")
        XCTAssertEqual(AdminInviteCode.format("267N2WSHSP999BJY"), "267N-2WSH-SP99-9BJY")
        XCTAssertEqual(AdminInviteCode.link(server: "https://atelier.example.com/", code: "267N-2WSH-SP99-9BJY")?.absoluteString, "https://atelier.example.com/#/invite/267N2WSHSP999BJY")
        XCTAssertNil(AdminInviteCode.link(server: "atelier.example.com", code: "267N-2WSH-SP99-9BJY"))
        XCTAssertNil(AdminInviteCode.link(server: "https://atelier.example.com", code: "nope"))
        let message = AdminInviteCode.message(server: "https://atelier.example.com", code: "267N-2WSH-SP99-9BJY", role: .admin, expiresAt: nil)
        XCTAssertTrue(message.contains("atelier.example.com"))
        XCTAssertTrue(message.contains("#/invite/267N2WSHSP999BJY"))
        XCTAssertTrue(message.contains("267N-2WSH-SP99-9BJY"))
        XCTAssertTrue(message.contains("admin account"))
        let password = AdminTemporaryPassword.message(server: "https://atelier.example.com", username: "mia", password: "Ab3Kd-9xQmZ-7Wt2L")
        XCTAssertTrue(password.contains("Username: mia") && password.contains("Ab3Kd-9xQmZ-7Wt2L"))
    }

    // MARK: - Limits

    func testLimitAmountsAreTypedTheWayTheDesktopTakesThem() {
        func parse(_ key: AdminLimitKey, _ text: String) -> Double? { AdminLimitAmount.parse(key, text) }
        XCTAssertEqual(parse(.tokensPerDay, "500000"), 500_000)
        XCTAssertEqual(parse(.tokensPerDay, "500,000"), 500_000)
        XCTAssertEqual(parse(.tokensPerDay, " 500k "), 500_000)
        XCTAssertEqual(parse(.tokensPer30Days, "2M"), 2_000_000)
        XCTAssertEqual(parse(.tokensPerDay, "1.5k"), 1_500)
        XCTAssertNil(parse(.tokensPerDay, "0"))
        XCTAssertNil(parse(.tokensPerDay, "abc"))
        XCTAssertNil(parse(.tokensPerDay, "12.3.4"))
        XCTAssertNil(parse(.tokensPerDay, ".5"))
        XCTAssertNil(parse(.tokensPerDay, "5."))
        XCTAssertNil(parse(.tokensPerDay, "-5"))
        XCTAssertNil(parse(.tokensPerDay, ""))
        XCTAssertEqual(parse(.requestsPerHour, "30"), 30)
        XCTAssertNil(parse(.requestsPerHour, "0"))
        XCTAssertEqual(parse(.costUsdPerDay, "5"), 5)
        XCTAssertEqual(parse(.costUsdPerDay, "$5"), 5)
        XCTAssertEqual(parse(.costUsdPerDay, "0.50"), 0.5)
        XCTAssertEqual(parse(.costUsdPer30Days, ".5"), 0.5)
        XCTAssertEqual(parse(.costUsdPer30Days, "5."), 5)
        XCTAssertNil(parse(.costUsdPerDay, "0"))
        XCTAssertNil(parse(.costUsdPerDay, "five"))
        XCTAssertNil(parse(.costUsdPerDay, "1k"))
        XCTAssertEqual(AdminLimitAmount.text(500_000), "500000")
        XCTAssertEqual(AdminLimitAmount.text(2.5), "2.5")
    }

    func testLimitAmountsRead() {
        XCTAssertEqual(AdminLimitAmount.tokens(999), "999")
        XCTAssertEqual(AdminLimitAmount.tokens(420_000), "420K")
        XCTAssertEqual(AdminLimitAmount.tokens(1_000_000), "1M")
        XCTAssertEqual(AdminLimitAmount.usd(2.4), "$2.40")
        XCTAssertEqual(AdminLimitAmount.usd(1280), "$1,280.00")
        XCTAssertEqual(AdminLimitAmount.usd(0.001), "<$0.01")
        XCTAssertEqual(AdminLimitAmount.used(.tokensPerDay, used: 420_000, max: 1_000_000), "420K of 1M tokens")
        XCTAssertEqual(AdminLimitAmount.used(.costUsdPerDay, used: 2.4, max: 5), "$2.40 of $5.00")
        XCTAssertEqual(AdminLimitAmount.used(.requestsPerHour, used: 12, max: 30), "12 of 30 requests")
        XCTAssertEqual(AdminLimitAmount.used(.requestsPerHour, used: 0, max: 1), "0 of 1 request")
        XCTAssertEqual(AdminLimitAmount.limit(.tokensPerDay, 200_000), "200,000 tokens")
        XCTAssertEqual(AdminLimitAmount.limit(.costUsdPerDay, 5), "$5.00")
        XCTAssertEqual(AdminLimitAmount.limit(.requestsPerHour, 1), "1 request")
    }

    func testUsageAgainstLimits() {
        let people = json(#"""
        [{"id":"a","username":"anna","name":"Anna","disabled":false,"status":{"exempt":false,"rows":[{"key":"tokensPerDay","used":100,"max":1000,"resetsAt":1800000000000,"reached":false,"near":false},{"key":"requestsPerHour","used":30,"max":30,"resetsAt":null,"reached":true,"near":true,"overridden":true},{"key":"somethingNew","used":1,"max":2,"resetsAt":null,"reached":false,"near":false}],"unpriced":0},"own":{}},
         {"id":"b","username":"ben","name":"Ben","disabled":false,"status":{"exempt":false,"rows":[{"key":"costUsdPerDay","used":4.5,"max":5,"resetsAt":1800000000000,"reached":false,"near":true}],"unpriced":3},"own":{"costUsdPerDay":null}},
         {"id":"c","username":"cy","name":"Cy","disabled":false,"status":{"exempt":true,"rows":[],"unpriced":0},"own":{"exempt":true}},
         {"id":"d","username":"di","name":"Di","disabled":true,"status":{"exempt":false,"rows":[],"unpriced":0},"own":{}},
         {"id":"e","username":"ed","name":"Abe","disabled":false,"status":{"exempt":false,"rows":[],"unpriced":0},"own":{}}]
        """#).array.map(AdminPersonLimits.init)
        let anna = people[0]
        XCTAssertEqual(anna.rows.count, 2, "a limit this app does not know is left out")
        XCTAssertEqual(anna.closest?.key, .requestsPerHour)
        XCTAssertEqual(anna.closest?.percent, 100)
        XCTAssertTrue(anna.closest?.overridden ?? false)
        XCTAssertNil(anna.unpricedNote)
        XCTAssertTrue(people[1].unpricedNote?.hasPrefix("3 requests in the last 30 days had no price") ?? false)
        XCTAssertTrue(people[1].hasOwn)
        XCTAssertTrue(people[2].exempt)
        XCTAssertEqual(AdminPersonLimits.ordered(people).map(\.name), ["Anna", "Ben", "Abe", "Cy"], "at a limit, near one, then by name; disabled people are left out")
        let snapshot = AdminLimitsSnapshot(people: people, system: AdminLimitsSnapshot.system(from: json(#"{"effective":{"limits":{"tokensPerDay":200000,"costUsdPerDay":2.5,"other":1}}}"#)))
        XCTAssertEqual(snapshot.system, [.tokensPerDay: 200_000, .costUsdPerDay: 2.5])
        XCTAssertTrue(snapshot.anyLimitSet)
        XCTAssertFalse(AdminLimitsSnapshot(people: [people[4]], system: [:]).anyLimitSet)
    }

    func testMeterNotes() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func row(_ key: String, used: Double, max: Double, resets: Double?) -> AdminLimitRow {
            AdminLimitRow(json(#"{"key":"\#(key)","used":\#(used),"max":\#(max),"resetsAt":\#(resets.map { String($0 * 1000) } ?? "null"),"reached":\#(used >= max),"near":\#(used >= max * 0.8)}"#))!
        }
        XCTAssertEqual(row("requestsPerHour", used: 30, max: 30, resets: nil).note(now: now), "Limit reached. It lifts when the running requests finish.")
        XCTAssertTrue(row("tokensPerDay", used: 100, max: 100, resets: 1_800_003_600).note(now: now).hasPrefix("Limit reached. It lifts at "))
        XCTAssertTrue(row("tokensPerDay", used: 85, max: 100, resets: 1_800_000_000 + 86400 * 2).note(now: now).hasPrefix("85% used. Resets on "))
        XCTAssertTrue(row("tokensPerDay", used: 10, max: 100, resets: 1_800_003_600).note(now: now).hasSuffix("(00:00 UTC)."))
        XCTAssertEqual(row("requestsPerHour", used: 1, max: 30, resets: nil).note(now: now), "Counts the last 60 minutes.")
        XCTAssertEqual(row("tokensPer30Days", used: 1, max: 30, resets: 1_800_003_600).note(now: now), "Counts today and the 29 days before it.")
        XCTAssertTrue(AdminLimitRow.resetText(Date(timeIntervalSince1970: 1_800_003_600), now: now).hasPrefix("at "))
        XCTAssertTrue(AdminLimitRow.resetText(Date(timeIntervalSince1970: 1_800_000_000 + 86400 * 2), now: now).hasPrefix("on "))
    }

    func testOwnLimitsAreDraftedAndSentInTheServersShape() {
        let own = json(#"{"tokensPerDay":500000,"requestsPerHour":null,"costUsdPer30Days":12.5}"#)
        let draft = AdminLimitDraft(own: own)
        XCTAssertEqual(draft.choice(.tokensPerDay), .custom)
        XCTAssertEqual(draft.amount(.tokensPerDay), "500000")
        XCTAssertEqual(draft.choice(.requestsPerHour), .off)
        XCTAssertEqual(draft.choice(.costUsdPer30Days), .custom)
        XCTAssertEqual(draft.amount(.costUsdPer30Days), "12.5")
        XCTAssertEqual(draft.choice(.tokensPer30Days), .inherit)
        XCTAssertNil(draft.problem)
        XCTAssertEqual(draft.json, own, "an untouched draft sends what it was given")

        var typing = draft
        typing.amount[.tokensPerDay] = "2M"
        XCTAssertEqual(typing.json["tokensPerDay"], .number(2_000_000))
        typing.amount[.tokensPerDay] = "lots"
        XCTAssertEqual(typing.problem, .tokensPerDay)
        typing.choice[.tokensPerDay] = .inherit
        XCTAssertNil(typing.problem)
        XCTAssertEqual(typing.json["tokensPerDay"], .null, "an inherited limit is not sent at all")
        XCTAssertFalse(typing.json.entries.contains { $0.0 == "tokensPerDay" })

        var exempt = AdminLimitDraft()
        XCTAssertEqual(exempt.json, .object([:]), "nothing set is an empty override")
        exempt.exempt = true
        exempt.choice[.costUsdPerDay] = .custom
        exempt.amount[.costUsdPerDay] = "nonsense"
        XCTAssertNil(exempt.problem, "exempt people have no limits to check")
        XCTAssertEqual(exempt.json["exempt"], .bool(true))

        XCTAssertFalse(AdminLimitDraft.hasOverrides(json(#"{"exempt":false}"#)))
        XCTAssertTrue(AdminLimitDraft.hasOverrides(json(#"{"requestsPerHour":null}"#)))
        XCTAssertEqual(AdminLimitDraft.summary(own: json(#"{"exempt":true}"#), system: [:]), "No limits")
        XCTAssertEqual(AdminLimitDraft.summary(own: .object([:]), system: [:]), "No limits set")
        XCTAssertEqual(AdminLimitDraft.summary(own: .object([:]), system: [.tokensPerDay: 1]), "Like everyone")
        XCTAssertEqual(AdminLimitDraft.summary(own: own, system: [:]), "Own limits")
    }

    // MARK: - Server

    func testVersionsCompareAsTheServerDoes() {
        XCTAssertLessThan(AdminVersion.compare("0.10.1", "0.11.0"), 0)
        XCTAssertGreaterThan(AdminVersion.compare("0.11.0", "0.10.1"), 0)
        XCTAssertLessThan(AdminVersion.compare("0.9.9", "0.10.0"), 0, "numbers, not text")
        XCTAssertEqual(AdminVersion.compare("1.2.3", "v1.2.3+build5"), 0)
        XCTAssertLessThan(AdminVersion.compare("1.0.0-beta.1", "1.0.0"), 0, "a release outranks its pre-releases")
        XCTAssertLessThan(AdminVersion.compare("1.0.0-beta.2", "1.0.0-beta.10"), 0)
        XCTAssertGreaterThan(AdminVersion.compare("1.0.0-alpha", "1.0.0-1"), 0)
        XCTAssertLessThan(AdminVersion.compare("1.0.0-alpha", "1.0.0-alpha.1"), 0)
    }

    func testUpdateStatesRead() {
        func status(_ extra: String) -> AdminServerUpdate? {
            AdminServerUpdate(json(#"{"version":"0.10.1","latest":{"version":"0.11.0","checkedAt":1794908959913},"latestError":null,"install":"updater","image":"ghcr.io/x/atelier:latest","updaterError":null,"job":null\#(extra)}"#))
        }
        let available = status("")!
        XCTAssertEqual(available.newerVersion, "0.11.0")
        XCTAssertEqual(available.versionDetail, "Atelier 0.11.0 is available.")
        XCTAssertEqual(available.updateDetail, "Downloads the new version and restarts the server.")
        XCTAssertFalse(available.isRunning)
        XCTAssertNil(available.failure)
        XCTAssertEqual(available.install, .updater)

        let upToDate = AdminServerUpdate(json(#"{"version":"0.11.0","latest":{"version":"0.11.0","checkedAt":1794908959913},"latestError":null,"install":"updater","image":null,"updaterError":null,"job":null}"#))!
        XCTAssertNil(upToDate.newerVersion)
        XCTAssertTrue(upToDate.versionDetail.hasPrefix("Up to date. Checked "))
        XCTAssertNil(upToDate.updateDetail)

        let unknown = AdminServerUpdate(json(#"{"version":"0.11.0","latest":null,"latestError":"Could not reach the feed.","install":"updater","image":null,"updaterError":null,"job":null}"#))!
        XCTAssertEqual(unknown.versionDetail, "Could not reach the feed.")
        let checking = AdminServerUpdate(json(#"{"version":"0.11.0","latest":null,"latestError":null,"install":"updater","image":null,"updaterError":null,"job":null}"#))!
        XCTAssertEqual(checking.versionDetail, "Checking for a newer version…")

        let manual = AdminServerUpdate(json(#"{"version":"0.10.1","latest":{"version":"0.11.0","checkedAt":1},"latestError":null,"install":"manual","image":null,"updaterError":"The updater can’t be reached at http://updater:7341.","job":null}"#))!
        XCTAssertEqual(manual.install, .manual)
        XCTAssertTrue(manual.updateDetail?.hasPrefix("The updater can’t be reached at http://updater:7341. To update, run the command below") ?? false)
        let noUpdater = AdminServerUpdate(json(#"{"version":"0.10.1","latest":null,"latestError":null,"install":"manual","image":null,"updaterError":null,"job":null}"#))!
        XCTAssertTrue(noUpdater.updateDetail?.hasPrefix("This server has no updater service.") ?? false)
        XCTAssertEqual(AdminServerUpdate.manualCommand, "docker compose pull && docker compose up -d")

        let source = AdminServerUpdate(json(#"{"version":"0.10.1","latest":{"version":"0.11.0","checkedAt":1},"latestError":null,"install":"source","image":null,"updaterError":null,"job":null}"#))!
        XCTAssertEqual(source.install, .source)
        XCTAssertEqual(source.updateDetail, "This server was built from source. Update it by rebuilding its image.")

        XCTAssertNil(AdminServerUpdate(.null), "a desktop app's own backend has nothing to update here")
    }

    func testUpdateProgress() {
        let pulling = status(job: #"{"state":"pulling","message":null,"startedAt":1,"finishedAt":null,"progress":{"done":126000000,"total":300000000,"percent":42,"unpacking":false}}"#)
        XCTAssertTrue(pulling.isRunning)
        XCTAssertEqual(pulling.updateDetail, "Downloading the new version… 42% · 126 MB of 300 MB")
        XCTAssertEqual(pulling.progressFraction, 0.42)
        let unpacking = status(job: #"{"state":"pulling","message":null,"startedAt":1,"finishedAt":null,"progress":{"done":300000000,"total":300000000,"percent":100,"unpacking":true}}"#)
        XCTAssertEqual(unpacking.updateDetail, "Unpacking the new version…")
        let old = status(job: #"{"state":"pulling","message":"Pulling layer 3","startedAt":1,"finishedAt":null}"#)
        XCTAssertEqual(old.updateDetail, "Downloading the new version… Pulling layer 3", "an updater from before 0.7.1 has no progress")
        XCTAssertNil(old.progressFraction)
        let restarting = status(job: #"{"state":"restarting","message":null,"startedAt":1,"finishedAt":null,"progress":null}"#)
        XCTAssertTrue(restarting.isRunning)
        XCTAssertEqual(restarting.progressFraction, 1)
        XCTAssertTrue(restarting.updateDetail?.hasPrefix("This takes a minute or so.") ?? false)
        let failed = status(job: #"{"state":"failed","message":"pull access denied","startedAt":1,"finishedAt":2,"progress":null}"#)
        XCTAssertFalse(failed.isRunning)
        XCTAssertEqual(failed.failure, "The last update failed: pull access denied.")
        XCTAssertEqual(failed.failureReason, "pull access denied")
        XCTAssertNil(status(job: #"{"state":"idle","message":null,"startedAt":null,"finishedAt":null,"progress":null}"#).failureReason)
        let done = status(job: #"{"state":"done","message":null,"startedAt":1,"finishedAt":1794908959913,"progress":null}"#)
        XCTAssertTrue(done.updateDetail?.hasPrefix("Updated ") ?? false)
        XCTAssertEqual(AdminServerUpdate.megabytes(5_400_000), "5.4 MB")
        XCTAssertEqual(AdminServerUpdate.megabytes(126_000_000), "126 MB")
    }

    private func status(job: String) -> AdminServerUpdate {
        AdminServerUpdate(json(#"{"version":"0.10.1","latest":{"version":"0.11.0","checkedAt":1},"latestError":null,"install":"updater","image":null,"updaterError":null,"job":\#(job)}"#))!
    }

    func testIdentityProviders() {
        XCTAssertEqual(AdminSSO.providerID(for: "Authentik"), "authentik")
        XCTAssertEqual(AdminSSO.providerID(for: "My Company SSO!"), "my-company-sso")
        XCTAssertEqual(AdminSSO.providerID(for: "Zürich Login"), "zurich-login")
        XCTAssertEqual(AdminSSO.providerID(for: "  --  "), "sso")
        XCTAssertEqual(AdminSSO.providerID(for: ""), "sso")
        XCTAssertEqual(AdminSSO.providerID(for: String(repeating: "ab ", count: 30)).count <= 40, true)
        XCTAssertFalse(AdminSSO.providerID(for: String(repeating: "ab ", count: 30)).hasSuffix("-"))
        XCTAssertEqual(AdminSSO.redirectURI(base: "https://atelier.example.com/api/auth/oidc/", id: "authentik"), "https://atelier.example.com/api/auth/oidc/authentik/callback")

        var draft = AdminProviderDraft()
        XCTAssertFalse(draft.isValid)
        XCTAssertNotNil(draft.nameProblem)
        XCTAssertNotNil(draft.issuerProblem)
        XCTAssertNotNil(draft.clientIdProblem)
        draft.name = "Authentik"; draft.issuer = "https://auth.example.com/application/o/atelier/"; draft.clientId = "atelier"
        XCTAssertTrue(draft.isValid)
        XCTAssertEqual(draft.params(id: nil), ["name": "Authentik", "issuer": "https://auth.example.com/application/o/atelier/", "clientId": "atelier", "newAccounts": "pending"], "no secret typed keeps the stored one")
        draft.secret = "s3cret"; draft.newAccounts = .none
        let params = draft.params(id: "authentik")
        XCTAssertEqual(params["clientSecret"], "s3cret")
        XCTAssertEqual(params["id"], "authentik")
        XCTAssertEqual(params["newAccounts"], "none")
        draft.issuer = "auth.example.com"
        XCTAssertNotNil(draft.issuerProblem)
        draft.issuer = "ftp://auth.example.com"
        XCTAssertNotNil(draft.issuerProblem)
        draft.name = String(repeating: "x", count: 61)
        XCTAssertEqual(draft.nameProblem, "Use at most 60 characters.")

        let provider = AdminProvider(json(#"{"id":"authentik","name":"Authentik","issuer":"https://a.example.com","clientId":"c","secret":"••••3f9a","newAccounts":"user","people":3}"#))
        XCTAssertEqual(provider.newAccounts, .user)
        XCTAssertEqual(provider.secret, "••••3f9a")
        XCTAssertEqual(AdminProviderDraft(provider).newAccounts, .user)
        XCTAssertEqual(AdminProvider(json(#"{"id":"x","name":"X","issuer":"i","clientId":"c","secret":null,"newAccounts":"future","people":0}"#)).newAccounts, .pending, "an unknown choice reads as the careful one")
        XCTAssertEqual(AdminServerSnapshot.platformName("darwin"), "macOS")
        XCTAssertEqual(AdminServerSnapshot.platformName("linux"), "Linux")
    }

    // MARK: - Activity

    private static let knownKinds = ["signin.success", "signin.failed", "signin.blocked", "signin.terminal_approved", "signin.terminal_denied", "account.created", "account.updated", "account.role_changed", "account.disabled", "account.enabled", "account.deleted", "account.password_reset", "invite.created", "invite.revoked", "invite.used", "identity.saved", "identity.removed", "settings.changed", "settings.reset", "settings.instructions", "provider.added", "provider.changed", "provider.removed", "provider.connected", "provider.disconnected", "secret.created", "secret.rotated", "secret.deleted", "connector.added", "connector.changed", "connector.removed", "connector.signed_in", "connector.signed_out", "plugin.installed", "plugin.removed", "plugin.enabled", "plugin.disabled", "plugin.changed", "skill.installed", "skill.removed", "model.hidden", "model.unhidden", "model.changed", "limits.changed", "server.update_started", "audit.exported"]

    func testEveryKindTheServerWritesHasWordsAndAnIcon() {
        XCTAssertEqual(Self.knownKinds.count, 46)
        for kind in Self.knownKinds {
            let title = AdminAuditText.title(forKind: kind)
            XCTAssertFalse(title.contains("."), "\(kind) reads as \(title)")
            XCTAssertFalse(title.contains("_"), "\(kind) reads as \(title)")
            XCTAssertNotNil(AdminAuditCategory.of(kind: kind), kind)
        }
        XCTAssertEqual(AdminAuditCategory.allCases.count, 14)
        XCTAssertEqual(AdminAuditText.title(forKind: "signin.failed"), "Failed sign-in")
        XCTAssertEqual(AdminAuditText.title(forKind: "plugin.futureevent"), "Plugins: futureevent", "a newer server's kind reads from its own name")
        XCTAssertEqual(AdminAuditText.title(forKind: "brandnew.thing_happened"), "Thing happened")
        XCTAssertNil(AdminAuditCategory.of(kind: "brandnew.thing"))
        XCTAssertEqual(AdminAuditCategory.of(kind: "limits.changed"), .limits)
    }

    func testEventsReadInWords() {
        let signin = AdminAuditEvent(json(#"{"id":"1","at":1794908959348,"kind":"signin.success","actorId":"u","actor":"demo","target":"demo","summary":"demo signed in","detail":{"method":"password","client":"mobile"},"ip":"127.0.0.1"}"#))
        XCTAssertEqual(signin.title, "Signed in")
        XCTAssertEqual(signin.tone, .normal)
        XCTAssertEqual(signin.symbol, "person.badge.key")
        let rows = signin.rows
        XCTAssertEqual(rows.first { $0.label == "Sign-in method" }?.value, "Password")
        XCTAssertEqual(rows.first { $0.label == "App" }?.value, "iPhone or iPad app")
        XCTAssertEqual(rows.first { $0.label == "Address" }?.value, "127.0.0.1")
        XCTAssertEqual(rows.first { $0.label == "By" }?.value, "demo")
        XCTAssertNil(rows.first { $0.label == "Account" }, "the account is the one who signed in: said once")
        XCTAssertEqual(rows.map(\.label).count, Set(rows.map(\.label)).count, "no label twice")

        let failed = AdminAuditEvent(json(#"{"id":"2","at":1,"kind":"signin.failed","actor":"jonas","target":"jonas","summary":"Failed sign-in as jonas","detail":{"reason":"wrong password"},"ip":null}"#))
        XCTAssertEqual(failed.tone, .warning)
        XCTAssertEqual(failed.rows.first { $0.label == "Name tried" }?.value, "jonas")
        XCTAssertEqual(failed.rows.first { $0.label == "Reason" }?.value, "Wrong password")
        XCTAssertNil(failed.rows.first { $0.label == "Address" })
        let blocked = AdminAuditEvent(json(#"{"id":"3","at":1,"kind":"signin.blocked","actor":null,"target":"admin","summary":"Sign-in as admin blocked after repeated failures","detail":{"limit":8},"ip":"192.0.2.99"}"#))
        XCTAssertEqual(blocked.tone, .danger)
        XCTAssertEqual(blocked.rows.first { $0.label == "Attempts allowed" }?.value, "8")

        let role = AdminAuditEvent(json(#"{"id":"4","at":1,"kind":"account.role_changed","actor":"philipp","target":"anna","summary":"Changed the role of anna from user to admin","detail":{"from":"user","to":"admin"},"ip":null}"#))
        XCTAssertEqual(role.rows.first { $0.label == "Was" }?.value, "User")
        XCTAssertEqual(role.rows.first { $0.label == "Now" }?.value, "Admin")
        let terminal = AdminAuditEvent(json(#"{"id":"5","at":1,"kind":"signin.terminal_approved","actor":"philipp","target":"Philipp's MacBook","summary":"s","detail":{"from":"203.0.113.24","platform":"darwin"},"ip":"203.0.113.24"}"#))
        XCTAssertEqual(terminal.rows.first { $0.label == "Device" }?.value, "Philipp's MacBook")
        let setting = AdminAuditEvent(json(#"{"id":"6","at":1,"kind":"settings.changed","actor":"philipp","target":"server.signup","summary":"Changed server.signup: invite → open","detail":{"path":"server.signup","from":"invite","to":"open"},"ip":null}"#))
        XCTAssertEqual(setting.rows.first { $0.label == "Setting" }?.value, "Sign-up")
        XCTAssertEqual(setting.sentence, "Changed Sign-up: invite → open", "a settings path reads as the page names it")
        XCTAssertEqual(signin.sentence, "demo signed in")
        XCTAssertEqual(setting.rows.first { $0.label == "Was" }?.value, "invite")
        let invite = AdminAuditEvent(json(#"{"id":"7","at":1,"kind":"invite.created","actor":"anna","target":"629d8314-a4c3-41c2-9de8-3bf2dafcdae8","summary":"Created an invite for a user","detail":{"role":"user","expiresAt":1795513796115},"ip":null}"#))
        XCTAssertNil(invite.rows.first { $0.label == "About" || $0.label == "Account" }, "an id is not shown")
        XCTAssertNotNil(invite.rows.first { $0.label == "Expires" })
        let unknown = AdminAuditEvent(json(#"{"id":"8","at":1,"kind":"plugin.futureevent","actor":"anna","target":"x","summary":"s","detail":{"someNewKey":"value","enabled":false,"count":3,"nothing":null},"ip":null}"#))
        let facts = Dictionary(uniqueKeysWithValues: unknown.rows.map { ($0.label, $0.value) })
        XCTAssertEqual(facts["Some new key"], "value")
        XCTAssertEqual(facts["Turned on"], "No")
        XCTAssertEqual(facts["Count"], "3")
        XCTAssertEqual(facts["Nothing"], "—")
    }

    func testWordsForKeysAndSettings() {
        XCTAssertEqual(AdminAuditText.humanize("tokensPerDay"), "Tokens per day")
        XCTAssertEqual(AdminAuditText.humanize("signed_in"), "Signed in")
        XCTAssertEqual(AdminAuditText.settingName("server.signup"), "Sign-up")
        XCTAssertEqual(AdminAuditText.settingName("limits.tokensPerDay"), "Tokens per person per day")
        XCTAssertEqual(AdminAuditText.settingName("safeguards.categories.selfHarm"), "Safeguards › Categories › Self harm")
        XCTAssertEqual(AdminAuditText.display(.bool(true)), "Yes")
        XCTAssertEqual(AdminAuditText.display(.number(2.5)), "2.5")
        XCTAssertEqual(AdminAuditText.display(.null), "—")
    }

    func testFiltersAreSentInTheServersShape() {
        var filter = AdminAuditFilter()
        XCTAssertFalse(filter.isActive)
        XCTAssertEqual(filter.params(calendar: utc), [:])
        filter.category = .account
        filter.person = "  mia "
        let day = Date(timeIntervalSince1970: 1_700_000_000)
        filter.from = day
        filter.to = day
        XCTAssertTrue(filter.isActive)
        let params = filter.params(calendar: utc)
        XCTAssertEqual(params["kind"], "account")
        XCTAssertEqual(params["user"], "mia")
        XCTAssertEqual(params["from"], .number(1_699_920_000_000), "the start of the first day")
        XCTAssertEqual(params["to"], .number(1_700_006_399_999), "the last millisecond of the last day")
        XCTAssertTrue(filter.summary.hasPrefix("Accounts · "))
        var spaces = AdminAuditFilter(); spaces.person = "   "
        XCTAssertFalse(spaces.isActive)
        XCTAssertEqual(spaces.params(calendar: utc), [:])
    }

    func testEventsAreGroupedByDay() {
        let calendar = utc
        let now = Date(timeIntervalSince1970: 1_700_040_000) // Nov 15 2023, 09:20 UTC
        func event(_ id: String, _ seconds: Double) -> AdminAuditEvent {
            AdminAuditEvent(json(#"{"id":"\#(id)","at":\#(seconds * 1000),"kind":"signin.success","summary":"s"}"#))
        }
        let days = AdminAudit.days([event("a", 1_700_039_000), event("b", 1_700_030_000), event("c", 1_699_960_000), event("d", 1_699_000_000)], calendar: calendar, now: now)
        XCTAssertEqual(days[0].title, "Today")
        XCTAssertEqual(days[1].title, "Yesterday")
        XCTAssertEqual(days.map { $0.events.map(\.id) }, [["a", "b"], ["c"], ["d"]])
        XCTAssertTrue(days[2].title.contains("Nov") && !days[2].title.contains("2023"), "this year's days have no year: \(days[2].title)")
        XCTAssertEqual(AdminAudit.exportFileName(now: now, calendar: calendar), "atelier-activity-2023-11-15.json")
        let page = AdminAuditPage(json(#"{"events":[{"id":"x","at":1,"kind":"k","summary":"s"}],"next":"50","retentionDays":90}"#))
        XCTAssertEqual(page.next, "50")
        XCTAssertEqual(page.retentionDays, 90)
        XCTAssertNil(AdminAuditPage(json(#"{"events":[],"next":null,"retentionDays":30}"#)).next)
        XCTAssertEqual(AdminAudit.retentionChoices.first, 7)
        XCTAssertEqual(AdminAudit.pageSize, 50)
    }

    // MARK: - Failures

    func testFailuresReadCalmly() {
        func message(_ text: String) -> String { AdminFailure.message(for: MobileError.message(text)) }
        XCTAssertEqual(message("Unknown method users.list"), "This server doesn't support this yet.")
        XCTAssertEqual(AdminFailure.kind(of: MobileError.message("Unknown method audit.list")), .unsupported)
        XCTAssertEqual(message("Only admins can do this."), "Only admins of this server can do this.")
        XCTAssertEqual(AdminFailure.kind(of: MobileError.message("Only admins can do this.")), .forbidden)
        XCTAssertEqual(AdminFailure.kind(of: MobileError.message("Only Atelier on the computer you’re connected to can do this.")), .elsewhere)
        XCTAssertEqual(AdminFailure.kind(of: MobileError.message("Not connected. Your draft is kept; reconnect before sending.")), .offline)
        XCTAssertEqual(AdminFailure.kind(of: MobileError.message("Connection interrupted. An action may have reached the server; refresh before retrying.")), .offline)
        XCTAssertEqual(message("Invalid params"), AdminFailure.rejectedText)
        XCTAssertEqual(message("The username “mia” is taken."), "The username “mia” is taken.", "the server's own words pass through")
        XCTAssertEqual(message("This is the only admin. Make someone else an admin first."), "This is the only admin. Make someone else an admin first.")
        XCTAssertEqual(AdminFailure.kind(ofMessage: AdminFailure.unsupportedText), .unsupported, "a message already translated stays translated")
    }

    // MARK: - The model layer, with a canned server

    /// A canned server: records every call and answers by method.
    private final class Canned: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [(method: String, params: [String: JSON])] = []
        var answers: [String: JSON] = [:]
        var failures: [String: String] = [:]

        func answer(_ method: String, _ params: [String: JSON]) throws -> JSON? {
            lock.lock(); defer { lock.unlock() }
            calls.append((method, params))
            if let message = failures[method] { throw MobileError.message(message) }
            return answers[method]
        }
        func params(_ method: String) -> [String: JSON]? { lock.lock(); defer { lock.unlock() }; return calls.last { $0.method == method }?.params }
        func count(_ method: String) -> Int { lock.lock(); defer { lock.unlock() }; return calls.filter { $0.method == method }.count }
    }

    private func makeStore(_ canned: Canned) -> AppStore {
        let store = AppStore()
        store.address = "https://atelier.example.com"
        store.rpc.stub = { method, params in try canned.answer(method, params) }
        return store
    }

    private let userJSON = #"{"id":"u2","username":"mia","name":"Mia Member","role":"user","avatar":null,"mustChangePassword":true,"hasPassword":true,"disabled":false,"safeguards":"inherit","createdAt":1794908939513,"lastActiveAt":null}"#

    func testUsersModelLoadsAndChangesPeople() async throws {
        let canned = Canned()
        canned.answers = [
            "users.list": json("[\(userJSON),{\"id\":\"u1\",\"username\":\"philipp\",\"name\":\"Philipp\",\"role\":\"admin\"},{\"id\":\"u9\",\"username\":\"tom\",\"name\":\"Tom\",\"role\":\"pending\",\"createdAt\":5}]"),
            "invites.list": json(#"[{"id":"i1","role":"user","hint":"9BJY","createdAt":1,"expiresAt":4102444800000,"usedAt":null,"usedBy":null},{"id":"i2","role":"user","hint":"K2M4","createdAt":1,"expiresAt":1000,"usedAt":null,"usedBy":null}]"#),
            "settings.get": json(#"{"effective":{"safeguards":{"enabled":true}}}"#),
        ]
        let store = makeStore(canned)
        let model = AdminUsersModel(rpc: store.rpc, selfID: "u1")
        await model.reload()
        let snapshot = try XCTUnwrap(model.snapshot)
        XCTAssertEqual(snapshot.members.map(\.username), ["philipp", "mia"])
        XCTAssertEqual(snapshot.waiting.map(\.username), ["tom"])
        XCTAssertEqual(snapshot.openInvites.count, 1)
        XCTAssertEqual(snapshot.pastInvites.count, 1)
        XCTAssertEqual(snapshot.safeguardsOn, true)
        XCTAssertNil(snapshot.invitesProblem)

        // Creating sends a normalized username and keeps the temporary password for the one screen that shows it.
        canned.answers["users.create"] = json(#"{"user":{"id":"u3","username":"zoe.park","name":"Zoe Park","role":"admin","mustChangePassword":true},"temporaryPassword":"Xk4Pq-9vTmZ-7Wt2L"}"#)
        let issued = try await model.create(username: " Zoe.Park ", name: " Zoe Park ", role: .admin)
        XCTAssertEqual(canned.params("users.create"), ["username": "zoe.park", "name": "Zoe Park", "role": "admin"])
        XCTAssertEqual(issued.password, "Xk4Pq-9vTmZ-7Wt2L")
        XCTAssertEqual(model.person("u3")?.name, "Zoe Park")

        // Only what changed is sent.
        canned.answers["users.update"] = json(userJSON.replacingOccurrences(of: #""disabled":false"#, with: #""disabled":true"#))
        let updated = await model.update("u2", disabled: true)
        XCTAssertTrue(updated)
        XCTAssertEqual(canned.params("users.update"), ["id": "u2", "disabled": true])
        XCTAssertEqual(model.person("u2")?.disabled, true)
        _ = await model.update("u2", name: "  Mia M ", role: .admin, safeguards: .off, limits: json(#"{"exempt":true}"#))
        XCTAssertEqual(canned.params("users.update"), ["id": "u2", "name": "Mia M", "role": "admin", "safeguards": "off", "limits": ["exempt": true]])

        // Approving makes a user; rejecting and deleting remove them.
        _ = await model.approve(try XCTUnwrap(model.person("u9")))
        XCTAssertEqual(canned.params("users.update"), ["id": "u9", "role": "user"])
        canned.answers["users.delete"] = ["ok": true]
        let rejected = await model.reject(try XCTUnwrap(model.person("u9")))
        XCTAssertTrue(rejected)
        XCTAssertEqual(canned.params("users.delete"), ["id": "u9"])
        XCTAssertNil(model.person("u9"))

        canned.answers["users.resetPassword"] = ["temporaryPassword": "Rn8Hc-2yBdF-5Qj9V"]
        let reset = await model.resetPassword(try XCTUnwrap(model.person("u2")))
        XCTAssertEqual(reset?.password, "Rn8Hc-2yBdF-5Qj9V")
        XCTAssertEqual(reset?.username, "mia")
        XCTAssertEqual(canned.params("users.resetPassword"), ["id": "u2"])

        // Invites.
        canned.answers["invites.create"] = json(#"{"invite":{"id":"i3","role":"admin","hint":"7QWE","createdAt":1,"expiresAt":4102444800000,"usedAt":null,"usedBy":null},"code":"267N-2WSH-SP99-9BJY"}"#)
        let invite = try await model.createInvite(role: .admin)
        XCTAssertEqual(canned.params("invites.create"), ["role": "admin"])
        XCTAssertEqual(invite.code, "267N-2WSH-SP99-9BJY")
        XCTAssertEqual(model.snapshot?.openInvites.count, 2)
        canned.answers["invites.revoke"] = ["ok": true]
        let revoked = await model.revoke(invite.invite)
        XCTAssertTrue(revoked)
        XCTAssertEqual(canned.params("invites.revoke"), ["id": "i3"])
        XCTAssertEqual(model.snapshot?.openInvites.count, 1)
    }

    func testUsersModelShowsTheServersWordsWhenAChangeFails() async throws {
        let canned = Canned()
        canned.answers = ["users.list": json("[\(userJSON)]"), "invites.list": json("[]")]
        let store = makeStore(canned)
        let model = AdminUsersModel(rpc: store.rpc, selfID: "u1")
        await model.reload()
        canned.failures["users.update"] = "This is the only admin. Make someone else an admin first."
        let before = model.person("u2")
        let worked = await model.update("u2", role: .user)
        XCTAssertFalse(worked)
        XCTAssertEqual(model.failure, "This is the only admin. Make someone else an admin first.")
        XCTAssertEqual(model.person("u2"), before, "nothing changes on screen")
        canned.failures["users.create"] = "The username “mia” is taken."
        do { _ = try await model.create(username: "mia", name: "Mia", role: .user); XCTFail("should have thrown") }
        catch { XCTAssertEqual(error.localizedDescription, "The username “mia” is taken.") }
        canned.failures["users.create"] = "Invalid params"
        do { _ = try await model.create(username: "mia", name: "Mia", role: .user); XCTFail("should have thrown") }
        catch { XCTAssertEqual(error.localizedDescription, AdminFailure.rejectedText) }
    }

    func testUsersModelCarriesOnWithoutInvitesOrSettings() async throws {
        let canned = Canned()
        canned.answers = ["users.list": json("[\(userJSON)]")]
        canned.failures = ["invites.list": "Unknown method invites.list", "settings.get": "Only admins can do this."]
        let model = AdminUsersModel(rpc: makeStore(canned).rpc, selfID: "u1")
        await model.reload()
        let snapshot = try XCTUnwrap(model.snapshot)
        XCTAssertEqual(snapshot.members.count, 1)
        XCTAssertEqual(snapshot.invitesProblem, AdminFailure.unsupportedText)
        XCTAssertNil(snapshot.safeguardsOn)

        canned.failures["users.list"] = "Only admins can do this."
        let refused = AdminUsersModel(rpc: makeStore(canned).rpc, selfID: "u1")
        await refused.reload()
        guard case .failed(let text) = refused.resource.state else { return XCTFail("the page fails when people cannot be listed") }
        XCTAssertEqual(AdminFailure.kind(ofMessage: text), .forbidden)
    }

    func testLimitsModelWritesTheSettingsPathsTheServerTakes() async throws {
        let canned = Canned()
        canned.answers = [
            "limits.everyone": json(#"[{"id":"u1","username":"p","name":"P","disabled":false,"status":{"exempt":false,"rows":[],"unpriced":0},"own":{}}]"#),
            "settings.get": json(#"{"effective":{"limits":{"tokensPerDay":200000}}}"#),
            "settings.set": ["ok": true], "settings.reset": ["ok": true],
        ]
        let model = AdminLimitsModel(rpc: makeStore(canned).rpc)
        await model.reload()
        XCTAssertEqual(model.snapshot?.system, [.tokensPerDay: 200_000])
        XCTAssertEqual(model.snapshot?.people.count, 1)
        try await model.setSystem(.costUsdPerDay, to: 2.5)
        XCTAssertEqual(canned.params("settings.set"), ["layer": "global", "path": ["limits", "costUsdPerDay"], "value": 2.5])
        try await model.setSystem(.requestsPerHour, to: 30)
        XCTAssertEqual(canned.params("settings.set"), ["layer": "global", "path": ["limits", "requestsPerHour"], "value": 30])
        try await model.setSystem(.tokensPerDay, to: nil)
        XCTAssertEqual(canned.params("settings.reset"), ["layer": "global", "path": ["limits", "tokensPerDay"]])
        XCTAssertEqual(canned.count("limits.everyone"), 4, "every change reads the page again")
        canned.failures["settings.set"] = "limits.tokensPerDay: Too small: expected number to be >0"
        do { try await model.setSystem(.tokensPerDay, to: 0.5); XCTFail("should have thrown") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Too small")) }
    }

    func testServerModelUpdatesAndSignup() async throws {
        let canned = Canned()
        let available = #"{"version":"0.10.1","latest":{"version":"0.11.0","checkedAt":1794908959913},"latestError":null,"install":"updater","image":null,"updaterError":null,"job":null}"#
        canned.answers = [
            "app.info": json(#"{"version":"0.10.1","platform":"linux","dataDir":"/data"}"#),
            "server.updates": json(available),
            "settings.get": json(#"{"effective":{"server":{"signup":"invite"}}}"#),
            "oidc.list": json(#"{"redirectBase":"https://atelier.example.com/api/auth/oidc","providers":[{"id":"authentik","name":"Authentik","issuer":"https://a.example.com","clientId":"c","secret":"••••3f9a","newAccounts":"pending","people":3}]}"#),
            "settings.set": ["ok": true], "oidc.remove": ["ok": true],
        ]
        let store = makeStore(canned)
        let model = AdminServerModel(store: store)
        await model.reload()
        var snapshot = try XCTUnwrap(model.snapshot)
        XCTAssertEqual(snapshot.version, "0.10.1")
        XCTAssertEqual(snapshot.platform, "Linux")
        XCTAssertEqual(snapshot.dataDir, "/data")
        XCTAssertEqual(snapshot.address, "https://atelier.example.com")
        XCTAssertEqual(snapshot.signup, .invite)
        XCTAssertEqual(snapshot.providers.map(\.name), ["Authentik"])
        XCTAssertEqual(snapshot.redirectBase, "https://atelier.example.com/api/auth/oidc")
        XCTAssertEqual(snapshot.update?.newerVersion, "0.11.0")
        XCTAssertFalse(snapshot.sharedComputer)

        await model.check()
        XCTAssertEqual(canned.params("server.updates"), ["refresh": true], "Check now skips the server's 10-minute memory")

        // Starting an update asks the updater, and the page shows what the server answered.
        canned.answers["server.update"] = json(#"{"version":"0.10.1","latest":{"version":"0.11.0","checkedAt":1},"latestError":null,"install":"updater","image":null,"updaterError":null,"job":{"state":"done","message":null,"startedAt":1,"finishedAt":2,"progress":null}}"#)
        await model.startUpdate()
        XCTAssertEqual(canned.count("server.update"), 1)
        XCTAssertEqual(model.snapshot?.update?.job?.state, .done)
        model.stopWatching()

        await model.setSignup(.open)
        XCTAssertEqual(canned.params("settings.set"), ["layer": "global", "path": ["server", "signup"], "value": "open"])
        XCTAssertEqual(model.snapshot?.signup, .open)
        let writes = canned.count("settings.set")
        await model.setSignup(.open)
        XCTAssertEqual(canned.count("settings.set"), writes, "the same choice is not written again")

        try await model.removeProvider(try XCTUnwrap(model.snapshot?.providers.first))
        XCTAssertEqual(canned.params("oidc.remove"), ["id": "authentik"])
        XCTAssertEqual(model.snapshot?.providers.count, 0)

        canned.answers["oidc.save"] = json(#"{"id":"google","name":"Google","issuer":"https://accounts.google.com","clientId":"id","secret":"••••wQ7z","newAccounts":"none","people":0}"#)
        var draft = AdminProviderDraft()
        draft.name = "Google"; draft.issuer = "https://accounts.google.com"; draft.clientId = "id"; draft.secret = "s"; draft.newAccounts = .none
        let saved = try await model.saveProvider(draft, id: nil)
        XCTAssertEqual(saved.id, "google")
        XCTAssertEqual(canned.params("oidc.save"), ["name": "Google", "issuer": "https://accounts.google.com", "clientId": "id", "clientSecret": "s", "newAccounts": "none"])
        snapshot = try XCTUnwrap(model.snapshot)
        XCTAssertEqual(snapshot.providers.map(\.id), ["google"])
    }

    func testServerPageOnASharedComputerAndOnAnOlderServer() async throws {
        let canned = Canned()
        canned.answers = ["app.info": json(#"{"version":"0.10.1","platform":"darwin","dataDir":"/Users/mia/.atelier","sharedComputer":true}"#), "server.updates": .null, "oidc.list": .null, "settings.get": json(#"{"effective":{"server":{"signup":"invite"}}}"#)]
        let model = AdminServerModel(store: makeStore(canned))
        await model.reload()
        let snapshot = try XCTUnwrap(model.snapshot)
        XCTAssertTrue(snapshot.sharedComputer)
        XCTAssertNil(snapshot.update, "a desktop app's own backend has no updater")
        XCTAssertNil(snapshot.redirectBase, "and no identity providers")

        canned.failures = ["server.updates": "Unknown method server.updates", "oidc.list": "Unknown method oidc.list"]
        canned.answers["app.info"] = json(#"{"version":"0.5.0"}"#)
        await model.reload()
        XCTAssertNil(model.snapshot?.update, "an older server still shows the page")
        XCTAssertEqual(model.snapshot?.version, "0.5.0")
    }

    func testActivityModelPagesFiltersAndExports() async throws {
        let canned = Canned()
        func event(_ id: Int) -> String { #"{"id":"e\#(id)","at":\#(1_794_908_959_000 - id * 1000),"kind":"signin.success","actor":"demo","target":"demo","summary":"demo signed in","detail":{"method":"password"},"ip":"127.0.0.1"}"# }
        canned.answers["audit.list"] = json(#"{"events":[\#(event(1)),\#(event(2))],"next":"2","retentionDays":90}"#)
        let model = AdminActivityModel(rpc: makeStore(canned).rpc)
        await model.reload(clear: true)
        XCTAssertEqual(model.events.map(\.id), ["e1", "e2"])
        XCTAssertEqual(model.next, "2")
        XCTAssertEqual(model.retentionDays, 90)
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(canned.params("audit.list"), ["limit": 50])

        canned.answers["audit.list"] = json(#"{"events":[\#(event(2)),\#(event(3))],"next":null,"retentionDays":90}"#)
        await model.loadMore()
        XCTAssertEqual(canned.params("audit.list"), ["limit": 50, "cursor": "2"])
        XCTAssertEqual(model.events.map(\.id), ["e1", "e2", "e3"], "an event that comes twice is shown once")
        XCTAssertNil(model.next)
        let calls = canned.count("audit.list")
        await model.loadMore()
        XCTAssertEqual(canned.count("audit.list"), calls, "nothing more to load")

        model.filter.category = .signin
        model.filter.person = "demo"
        await model.reload(clear: true)
        XCTAssertEqual(canned.params("audit.list"), ["limit": 50, "kind": "signin", "user": "demo"])

        canned.failures["audit.list"] = "Only admins can do this."
        await model.reload(clear: true)
        guard case .failed(let text) = model.phase else { return XCTFail("a failed first load shows the failure") }
        XCTAssertEqual(AdminFailure.kind(ofMessage: text), .forbidden)

        canned.answers["audit.export"] = json(#"{"exportedAt":1,"retentionDays":90,"truncated":true,"events":[\#(event(1)),\#(event(2)),\#(event(3))]}"#)
        let exported = await model.export()
        let file = try XCTUnwrap(exported)
        defer { try? FileManager.default.removeItem(at: file.url) }
        XCTAssertEqual(canned.params("audit.export"), ["kind": "signin", "user": "demo"], "the export follows the filters")
        XCTAssertEqual(file.count, 3)
        XCTAssertTrue(file.truncated)
        XCTAssertTrue(file.url.lastPathComponent.hasPrefix("atelier-activity-") && file.url.pathExtension == "json")
        let saved = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: file.url))
        XCTAssertEqual(saved["events"].array.count, 3)
        XCTAssertEqual(saved["truncated"], .bool(true))

        canned.answers["settings.set"] = ["ok": true]
        let kept = await model.setRetention(30)
        XCTAssertTrue(kept)
        XCTAssertEqual(canned.params("settings.set"), ["layer": "global", "path": ["audit", "retentionDays"], "value": 30])
        XCTAssertEqual(model.retentionDays, 30)
        canned.failures["settings.set"] = "audit.retentionDays: Too small: expected number to be >=7"
        let refused = await model.setRetention(3)
        XCTAssertFalse(refused)
        XCTAssertEqual(model.retentionDays, 30)
        XCTAssertNotNil(model.failure)
    }

    // MARK: - The demo answers in the shapes the screens read

    func testDemoAnswersInTheRealShapes() throws {
        XCTAssertNil(try AdminServerDemo.respond("sessions.list", [:]))
        let users = try XCTUnwrap(AdminServerDemo.respond("users.list", [:])).array.map(AdminPerson.init)
        XCTAssertGreaterThanOrEqual(users.count, 2)
        XCTAssertTrue(users.contains { $0.role == .admin })
        let limits = try XCTUnwrap(AdminServerDemo.respond("limits.everyone", [:])).array.map(AdminPersonLimits.init)
        XCTAssertFalse(limits.isEmpty)
        XCTAssertNotNil(AdminServerUpdate(try XCTUnwrap(AdminServerDemo.respond("server.updates", [:]))))
        let page = AdminAuditPage(try XCTUnwrap(AdminServerDemo.respond("audit.list", ["limit": 10])))
        XCTAssertEqual(page.events.count, 10)
        XCTAssertNotNil(page.next)
    }

    // MARK: - Against a live throwaway server

    /// Every call the pages make, with the exact parameters the app sends, against a real server. Needs a throwaway server
    /// (scripts/live-server.mjs): ATELIER_TEST_SERVER, ATELIER_TEST_USER and ATELIER_TEST_PASSWORD (an admin).
    func testTheAdminPagesAgainstALiveServer() async throws {
        guard let address = ProcessInfo.processInfo.environment["ATELIER_TEST_SERVER"],
              let username = ProcessInfo.processInfo.environment["ATELIER_TEST_USER"],
              let password = ProcessInfo.processInfo.environment["ATELIER_TEST_PASSWORD"] else {
            throw XCTSkip("Set a throwaway server's address and an admin's sign-in to run the admin integration test")
        }
        let store = AppStore()
        store.address = address
        try await store.login(username: username, password: password)
        defer { store.rpc.close() }
        let selfID = store.authStatus["user"]["id"].string
        let suffix = String(UUID().uuidString.prefix(6)).lowercased()

        // Users: create, change, reset, invite, delete.
        let users = AdminUsersModel(rpc: store.rpc, selfID: selfID)
        await users.reload()
        let loaded = try XCTUnwrap(users.snapshot, "users.list, invites.list and settings.get answer")
        XCTAssertTrue(loaded.people.contains { $0.id == selfID && $0.role == .admin })
        let issued = try await users.create(username: "Probe.\(suffix)", name: "Probe Person", role: .user)
        XCTAssertEqual(issued.username, "probe.\(suffix)")
        XCTAssertGreaterThanOrEqual(issued.password.count, 8)
        let probe = try XCTUnwrap(users.snapshot?.people.first { $0.username == "probe.\(suffix)" })
        XCTAssertEqual(probe.status, .temporaryPassword)
        var changed = await users.update(probe.id, name: "Probe Renamed", safeguards: .on, limits: json(#"{"tokensPerDay":500000,"requestsPerHour":null,"costUsdPer30Days":12.5}"#))
        XCTAssertTrue(changed, users.failure ?? "")
        XCTAssertEqual(users.person(probe.id)?.name, "Probe Renamed")
        XCTAssertEqual(users.person(probe.id)?.safeguards, .on)
        XCTAssertTrue(users.person(probe.id)?.hasOwnLimits ?? false)
        changed = await users.update(probe.id, disabled: true)
        XCTAssertTrue(changed)
        XCTAssertEqual(users.person(probe.id)?.status, .disabled)
        changed = await users.update(probe.id, role: .user, disabled: false, limits: .object([:]))
        XCTAssertTrue(changed)
        XCTAssertFalse(users.person(probe.id)?.hasOwnLimits ?? true, "empty limits clear the override")
        let reset = await users.resetPassword(probe)
        XCTAssertNotNil(reset)
        XCTAssertNotEqual(reset?.password, issued.password)
        do { _ = try await users.create(username: "probe.\(suffix)", name: "Again", role: .user); XCTFail("a taken username is refused") }
        catch { XCTAssertTrue(error.localizedDescription.contains("is taken"), error.localizedDescription) }
        // The only admin cannot step down (on a server with other admins this would really demote them, so it is not tried there).
        if loaded.people.filter({ $0.role == .admin }).count == 1 {
            changed = await users.update(selfID, role: .user)
            XCTAssertFalse(changed, "the only admin cannot step down")
            XCTAssertEqual(users.failure, "This is the only admin. Make someone else an admin first.")
            users.failure = nil
        }

        let invite = try await users.createInvite(role: .user)
        XCTAssertNotNil(AdminInviteCode.normalize(invite.code), invite.code)
        XCTAssertEqual(invite.invite.state(), .open)
        _ = try await store.rpc.adminCall("auth.checkInvite", ["invite": .string(AdminInviteCode.normalize(invite.code) ?? "")])
        XCTAssertNotNil(AdminInviteCode.link(server: address, code: invite.code))
        let revoked = await users.revoke(invite.invite)
        XCTAssertTrue(revoked)
        await users.reload()
        XCTAssertFalse(users.snapshot?.invites.contains { $0.id == invite.invite.id } ?? true)

        // Limits: the defaults, one person's override, everyone's usage.
        let limits = AdminLimitsModel(rpc: store.rpc)
        await limits.reload()
        XCTAssertNotNil(limits.snapshot)
        try await limits.setSystem(.tokensPerDay, to: 200_000)
        try await limits.setSystem(.costUsdPerDay, to: 2.5)
        XCTAssertEqual(limits.snapshot?.system[.tokensPerDay], 200_000)
        XCTAssertEqual(limits.snapshot?.system[.costUsdPerDay], 2.5)
        let mine = try XCTUnwrap(limits.snapshot?.people.first { $0.id == selfID })
        XCTAssertTrue(mine.rows.contains { $0.key == .tokensPerDay && $0.max == 200_000 })
        _ = await users.update(probe.id, limits: AdminLimitDraft(own: json(#"{"tokensPerDay":50000,"costUsdPerDay":null}"#)).json)
        await limits.reload()
        let theirs = try XCTUnwrap(limits.snapshot?.people.first { $0.id == probe.id })
        XCTAssertEqual(theirs.rows.first { $0.key == .tokensPerDay }?.max, 50_000)
        XCTAssertTrue(theirs.rows.first { $0.key == .tokensPerDay }?.overridden ?? false)
        XCTAssertNil(theirs.rows.first { $0.key == .costUsdPerDay }, "a lifted limit has no row")
        _ = await users.update(probe.id, limits: json(#"{"exempt":true}"#))
        await limits.reload()
        XCTAssertTrue(limits.snapshot?.people.first { $0.id == probe.id }?.exempt ?? false)
        do { try await limits.setSystem(.tokensPer30Days, to: 1.5); XCTFail("a fraction of a token is refused") }
        catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        try await limits.setSystem(.tokensPerDay, to: nil)
        try await limits.setSystem(.costUsdPerDay, to: nil)
        XCTAssertNil(limits.snapshot?.system[.tokensPerDay])

        // Server: version, sign-up policy, identity providers.
        let server = AdminServerModel(store: store)
        await server.reload()
        let facts = try XCTUnwrap(server.snapshot)
        XCTAssertFalse(facts.version.isEmpty)
        XCTAssertEqual(facts.signup, .invite)
        XCTAssertNotNil(facts.redirectBase)
        XCTAssertNotNil(facts.update)
        await server.check()
        XCTAssertNil(server.failure)
        await server.setSignup(.open)
        XCTAssertEqual(server.snapshot?.signup, .open)
        let after = try await store.rpc.adminCall("auth.status")
        XCTAssertEqual(after["signup"].string, "open")
        await server.setSignup(.invite)
        XCTAssertEqual(server.snapshot?.signup, .invite)
        var draft = AdminProviderDraft()
        draft.name = "Probe \(suffix)"; draft.issuer = "https://127.0.0.1:1/unreachable"; draft.clientId = "probe"
        do { _ = try await server.saveProvider(draft, id: nil); XCTFail("an unreachable provider is refused") }
        catch { XCTAssertFalse(error.localizedDescription.isEmpty, "the server says why") }

        // Activity: the list, a filter, the next page, the export, the retention.
        let activity = AdminActivityModel(rpc: store.rpc)
        await activity.reload(clear: true)
        XCTAssertEqual(activity.phase, .loaded)
        XCTAssertFalse(activity.events.isEmpty)
        XCTAssertTrue(activity.events.contains { $0.kind == "account.created" && $0.target == "probe.\(suffix)" })
        XCTAssertTrue(activity.events.allSatisfy { !$0.title.isEmpty && !$0.rows.isEmpty })
        activity.filter.category = .account
        await activity.reload(clear: true)
        XCTAssertFalse(activity.events.isEmpty)
        XCTAssertTrue(activity.events.allSatisfy { $0.category == .account })
        activity.filter.person = "probe.\(suffix)"
        await activity.reload(clear: true)
        XCTAssertFalse(activity.events.isEmpty)
        activity.filter.person = "nobody.at.all"
        await activity.reload(clear: true)
        XCTAssertTrue(activity.events.isEmpty)
        activity.filter = AdminAuditFilter()
        activity.filter.from = Date().addingTimeInterval(-3600)
        activity.filter.to = Date()
        await activity.reload(clear: true)
        XCTAssertFalse(activity.events.isEmpty, "everything above happened within the hour")
        activity.filter = AdminAuditFilter()
        await activity.reload(clear: true)
        let exported = await activity.export()
        let file = try XCTUnwrap(exported)
        defer { try? FileManager.default.removeItem(at: file.url) }
        XCTAssertGreaterThanOrEqual(file.count, activity.events.count)
        XCTAssertFalse(file.truncated)
        let kept = await activity.setRetention(90)
        XCTAssertTrue(kept)
        let short = await activity.setRetention(3)
        XCTAssertFalse(short)

        // Clean up what this test made.
        let gone = await users.delete(probe)
        XCTAssertTrue(gone)
        XCTAssertNil(users.person(probe.id))
        try await store.logout()
    }
}
