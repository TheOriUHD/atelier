import XCTest
@testable import Atelier

/// Runs the calls the chat screens make against a throwaway server (scripts/live-server.mjs), with the exact parameters
/// the app sends. Set ATELIER_TEST_SERVER (https address), ATELIER_TEST_USER and ATELIER_TEST_PASSWORD to run it.
@MainActor final class ChatIntegrationTests: XCTestCase {
    private func environment() throws -> (String, String, String) {
        guard let address = ProcessInfo.processInfo.environment["ATELIER_TEST_SERVER"],
              let username = ProcessInfo.processInfo.environment["ATELIER_TEST_USER"],
              let password = ProcessInfo.processInfo.environment["ATELIER_TEST_PASSWORD"] else { throw XCTSkip("Set ATELIER_TEST_SERVER, ATELIER_TEST_USER and ATELIER_TEST_PASSWORD to run the chat integration test") }
        return (address, username, password)
    }

    private func wait(_ what: String, timeout: TimeInterval = 20, _ condition: @escaping @MainActor () -> Bool) async {
        let deadline = Date.now.addingTimeInterval(timeout)
        while Date.now < deadline, !condition() { try? await Task.sleep(for: .milliseconds(100)) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    func testSigningInAndEveryFailureOfIt() async throws {
        let (address, username, password) = try environment()
        let store = AppStore()
        let model = ChatSignIn()
        // The server says what it offers.
        await model.check(address)
        XCTAssertEqual(model.probe, .ready)
        XCTAssertFalse(model.setupRequired)
        XCTAssertEqual(model.status["signup"].string, "invite")
        XCTAssertTrue(model.browserSignIn)
        // A wrong password says so in words, and nobody is signed in.
        await model.login(address: address, username: username, password: "not-the-password", store: store)
        XCTAssertEqual(model.error, "Wrong username or password.")
        XCTAssertFalse(store.signedIn)
        // An invite code that is wrong is refused before the account form.
        await model.checkInvite(address: address, code: "A1B2-C3D4-E5F6-G7H8")
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.screen, .signIn)
        await model.checkInvite(address: address, code: "short")
        XCTAssertTrue(model.error?.contains("16 letters and digits") == true)
        // Sign-up is by invitation here.
        await model.signup(address: address, name: "Nobody", username: "nobody", password: "a-long-password")
        XCTAssertTrue(model.error?.contains("invitation") == true, model.error ?? "no error")
        // A browser sign-in starts, and waits.
        await model.startBrowser(address: address, store: store)
        XCTAssertEqual(model.screen, .approval)
        XCTAssertEqual(model.flow?["code"].string.count, 9)
        model.cancelBrowser()
        // The right password signs in.
        await model.login(address: address, username: username, password: password, store: store)
        XCTAssertNil(model.error, model.error ?? "")
        XCTAssertTrue(store.signedIn)
        XCTAssertTrue(store.isAdmin)
        // A server that is not there is explained.
        let nowhere = ChatSignIn()
        await nowhere.check("https://127.0.0.1:1")
        XCTAssertNotNil(nowhere.probe.failure)
        try await store.logout()
    }

    func testInvitesAndATemporaryPassword() async throws {
        let (address, username, password) = try environment()
        let admin = AppStore()
        admin.address = address
        try await admin.login(username: username, password: password)
        let suffix = String(Int.random(in: 1000...9999))
        // An invite code opens an account form, once.
        let invite = try await admin.rpc.call("invites.create", ["role": "user"])
        let code = invite["code"].string
        let model = ChatSignIn()
        await model.check(address)
        await model.checkInvite(address: address, code: code)
        XCTAssertNil(model.error, model.error ?? "")
        XCTAssertEqual(model.screen, .newAccount)
        let invited = AppStore()
        await model.acceptInvite(address: address, name: "Invited Person", username: "invitee\(suffix)", password: "invitee-pass-123", store: invited)
        XCTAssertNil(model.error, model.error ?? "")
        XCTAssertTrue(invited.signedIn)
        XCTAssertFalse(invited.isAdmin)
        let again = ChatSignIn()
        await again.checkInvite(address: address, code: code)
        XCTAssertTrue(again.error?.contains("already used or expired") == true, again.error ?? "no error")
        // A temporary password has to be replaced before anything shows.
        let created = try await admin.rpc.call("users.create", ["username": .string("temp\(suffix)"), "name": "Temp Person", "role": "user"])
        let temporary = created["temporaryPassword"].string
        let store = AppStore()
        let third = ChatSignIn()
        await third.login(address: address, username: "temp\(suffix)", password: temporary, store: store)
        XCTAssertEqual(third.screen, .password)
        XCTAssertTrue(store.authStatus["user"]["mustChangePassword"].bool)
        await third.changePassword(current: temporary, next: "a-brand-new-password", store: store)
        XCTAssertNil(third.error, third.error ?? "")
        XCTAssertFalse(store.authStatus["user"]["mustChangePassword"].bool)
        XCTAssertTrue(ChatHub.of(store).listLoaded)
        // Clean up.
        try await store.logout()
        try await invited.logout()
        for user in try await admin.rpc.call("users.list").array where user["username"].string == "invitee\(suffix)" || user["username"].string == "temp\(suffix)" {
            _ = try await admin.rpc.call("users.delete", ["id": user["id"]])
        }
        try await admin.logout()
    }

    func testATemporaryChatCanBeKeptOrDeletedNow() async throws {
        let (address, username, password) = try environment()
        let store = AppStore()
        store.address = address
        try await store.login(username: username, password: password)
        // Keeping: a temporary chat becomes an ordinary one, in the list, and leaving it no longer deletes it.
        let kept = try await store.rpc.call("sessions.create", ["mode": "chat", "temporary": true])
        let keptID = kept["id"].string
        XCTAssertTrue(Conversation(raw: kept).isTemporary)
        try await store.open(keptID)
        try await ChatActions.keep(store, keptID)
        XCTAssertEqual(store.sessions.first { $0.id == keptID }?.isTemporary, false)
        XCTAssertEqual(store.transcript.snapshot["session"]["temporary"], .null)
        let left = try await store.rpc.call("sessions.leave", ["id": .string(keptID)])
        XCTAssertFalse(left["deleted"].bool)
        let listed = try await store.rpc.call("sessions.list", ["mode": "chat", "limit": 100]).array
        XCTAssertTrue(listed.contains { $0["id"].string == keptID })
        try await ChatActions.delete(store, keptID)
        // Delete now: the temporary chat is gone at once, even while it is open.
        let gone = try await store.rpc.call("sessions.create", ["mode": "chat", "temporary": true])
        try await store.open(gone["id"].string)
        try await ChatActions.delete(store, gone["id"].string)
        XCTAssertFalse(store.sessions.contains { $0.id == gone["id"].string })
        try await store.logout()
    }

    func testTheWholeOfAConversation() async throws {
        let (address, username, password) = try environment()
        let store = AppStore()
        store.address = address
        try await store.login(username: username, password: password)
        let hub = ChatHub.of(store)
        await hub.reloadAll()
        XCTAssertTrue(hub.listLoaded)
        XCTAssertNil(hub.listError)
        XCTAssertTrue(hub.shellLoaded)
        XCTAssertFalse(hub.settings["providers"].array.isEmpty)
        XCTAssertTrue(hub.webSearchOn)
        let model = hub.defaultModel(mode: "chat", models: store.models)
        XCTAssertFalse(model.isEmpty)

        // A new conversation with the page's choices, and its first message.
        store.selectedModel = model
        hub.newOptions.research = true
        store.draft = "Hello there, who are you?"
        let sent = await ChatSend.submit(store: store, hub: hub, hooks: ChatSend.Hooks(newConversation: {}, openModelPicker: {}, openSideChats: {}, notify: { _ in }))
        XCTAssertTrue(sent)
        guard let id = store.selected else { return XCTFail("the conversation was not opened") }
        XCTAssertTrue(ChatNav.loaded(store))
        XCTAssertTrue(ChatNav.session(store)?.research == true, "the research switch went with the new conversation")
        await wait("the reply") { store.transcript.messages.contains { $0["role"].string == "assistant" && !$0["parts"].array.isEmpty } && store.transcript.status == "idle" }

        // Everything the menus do.
        try await ChatActions.rename(store, id, to: "  A renamed conversation ")
        try await ChatActions.setPinned(store, id, true)
        try await ChatActions.update(store, id, ["thinking": false, "research": false, "connectorsOff": ["github"]])
        try await ChatActions.markSeen(store, id)
        try await ChatActions.setUnread(store, id)
        let listed = try await store.rpc.call("sessions.list", ["limit": 50]).array.map(Conversation.init).first { $0.id == id }
        XCTAssertEqual(listed?.raw["title"].string, "A renamed conversation")
        XCTAssertEqual(listed?.pinned, true)
        XCTAssertEqual(listed?.thinking, false)
        XCTAssertEqual(listed?.connectorsOff, ["github"])
        XCTAssertEqual(listed?.unseen, true)

        // Groups: create, rename, collapse, move into, delete.
        let group = try await ChatActions.createGroup(store, hub, name: "Work")
        try await ChatActions.renameGroup(store, hub, id: group["id"].string, name: "Work things")
        try await ChatActions.collapseGroup(store, hub, id: group["id"].string, collapsed: true)
        try await ChatActions.move(store, id, toGroup: group["id"].string)
        let grouped = try await store.rpc.call("sessions.list", ["limit": 50]).array.map(Conversation.init).first { $0.id == id }
        XCTAssertEqual(grouped?.groupID, group["id"].string)
        XCTAssertEqual(hub.groups.first { $0["id"] == group["id"] }?["name"].string, "Work things")
        XCTAssertEqual(hub.groups.first { $0["id"] == group["id"] }?["collapsed"].bool, true)
        try await ChatActions.move(store, id, toGroup: nil)

        // Projects: create, edit, a file, move the conversation in and out, delete.
        let project = try await ChatActions.createProject(store, name: "Chat test", description: "For the test")
        _ = try await ChatActions.updateProject(store, id: project["id"].string, patch: ["instructions": "Be brief.", "pinned": true, "name": "Chat test 2"])
        _ = try await ChatActions.addProjectFile(store, projectId: project["id"].string, data: Data("Some notes about the launch.".utf8), name: "notes.txt", mime: "text/plain")
        let details = try await store.rpc.call("projects.get", ["id": project["id"]])
        XCTAssertEqual(details["instructions"].string, "Be brief.")
        XCTAssertEqual(details["files"].array.count, 1)
        XCTAssertEqual(ChatProjectMeta.fileBudget(details["files"].array).over, [])
        try await ChatActions.move(store, id, toProject: project["id"].string)
        let inProject = try await store.rpc.call("sessions.list", ["projectId": project["id"], "mode": "chat", "limit": 100]).array
        XCTAssertEqual(inProject.map { $0["id"].string }, [id])
        try await ChatActions.move(store, id, toProject: nil)
        try await ChatActions.removeProjectFile(store, projectId: project["id"].string, fileId: details["files"].array[0]["id"].string)
        try await ChatActions.deleteProject(store, id: project["id"].string)
        XCTAssertFalse(store.projects.contains { $0["id"] == project["id"] })

        // A retry makes a second version of the reply, and switching goes back.
        let first = store.transcript.messages.first { $0["role"].string == "assistant" }?["id"].string ?? ""
        try await ChatActions.retry(store, first)
        await wait("the second version") { Branching.resolve(messages: store.transcript.messages, siblings: store.transcript.snapshot["siblings"]).siblings.values.contains { $0.count == 2 } && store.transcript.status == "idle" }
        var branch = Branching.resolve(messages: store.transcript.messages, siblings: store.transcript.snapshot["siblings"])
        XCTAssertEqual(branch.messages.filter { $0["role"].string == "assistant" }.count, 1, "only the new reply is on screen")
        let versions = branch.siblings.values.first { $0.count == 2 } ?? []
        XCTAssertTrue(versions.contains(first))
        try await ChatActions.switchBranch(store, to: first)
        branch = Branching.resolve(messages: store.transcript.messages, siblings: store.transcript.snapshot["siblings"])
        XCTAssertEqual(branch.messages.first { $0["role"].string == "assistant" }?["id"].string, first)

        // An edit of the message is a new version of it.
        let user = store.transcript.messages.first { $0["role"].string == "user" }?["id"].string ?? ""
        try await ChatActions.edit(store, messageId: user, parts: [.text("Hello again, who are you really?")])
        await wait("the edited message") { store.transcript.messages.contains { $0["parts"].array.contains { $0["text"].string.contains("really") } } && store.transcript.status == "idle" }

        // Context, usage, side chats.
        let breakdown = try await ChatActions.contextBreakdown(store)
        XCTAssertGreaterThan(breakdown["context"]["limit"].int, 0)
        XCTAssertEqual(ChatContext.rows(breakdown["context"]).reduce(0) { $0 + $1.tokens }, breakdown["context"]["limit"].int)
        let side = try await ChatActions.startSideChat(store, question: nil)
        let sideChats = try await ChatActions.sideChats(store, of: id)
        XCTAssertTrue(sideChats.contains { $0["id"].string == side })
        try await ChatActions.delete(store, side)

        // Co-op is off for a conversation of one's own; the directory answers.
        let state = try await store.rpc.call("coop.state", ["sessionId": .string(id)])
        XCTAssertEqual(state, .null)
        _ = try await ChatCoopActions.directory(store)

        // Slash commands: a skill list, and `/btw` asks a side question without joining the conversation.
        _ = try await store.rpc.call("slash.list", [:])
        store.draft = "/btw what is two plus two?"
        let ran = await ChatSend.submit(store: store, hub: hub, hooks: ChatSend.Hooks(newConversation: {}, openModelPicker: {}, openSideChats: {}, notify: { _ in }))
        XCTAssertTrue(ran)
        XCTAssertEqual(store.draft, "")
        let afterBtw = try await ChatActions.sideChats(store, of: id)
        XCTAssertEqual(afterBtw.count, 1)
        for chat in afterBtw { try await ChatActions.delete(store, chat["id"].string) }

        // Fork, archive and delete.
        let fork = try await ChatActions.fork(store, id)
        try await ChatActions.setArchived(store, fork, true)
        let archived = try await store.rpc.call("sessions.list", ["archived": "archived", "limit": 200]).array
        XCTAssertTrue(archived.contains { $0["id"].string == fork })
        let found = try await store.rpc.call("sessions.list", ["query": "really", "archived": "all", "limit": 60]).array
        XCTAssertTrue(found.contains { $0["id"].string == id }, "the search looks into what was said")
        try await ChatActions.setArchived(store, fork, false)
        try await ChatActions.delete(store, fork)

        // Artifacts and pictures: the lists answer (nothing was made).
        let artifacts = try await store.rpc.call("artifacts.listAll", ["limit": 60])
        XCTAssertNotEqual(artifacts["items"], .null)
        let pictures = try await store.rpc.call("generatedImages.list", ["limit": 60])
        XCTAssertNotEqual(pictures["items"], .null)

        // A temporary chat is never listed, and gone when left.
        store.selected = nil
        hub.newOptions.temporary = true
        store.selectedModel = model
        store.draft = "A secret question."
        _ = await ChatSend.submit(store: store, hub: hub, hooks: ChatSend.Hooks(newConversation: {}, openModelPicker: {}, openSideChats: {}, notify: { _ in }))
        let temporaryID = store.selected ?? ""
        XCTAssertEqual(ChatNav.session(store)?.isTemporary, true)
        let visible = try await store.rpc.call("sessions.list", ["limit": 200]).array
        XCTAssertFalse(visible.contains { $0["id"].string == temporaryID })
        await ChatNav.leaveTemporary(store)
        XCTAssertThrowsError(try { throw MobileError.message("x") }())

        // Mutations the server refuses are said calmly.
        do { _ = try await store.rpc.call("nothing.here"); XCTFail("an unknown procedure must fail") } catch { XCTAssertEqual(ChatError.text(error), ChatError.unsupported) }

        try await ChatActions.delete(store, id)
        try await store.logout()
    }
}
