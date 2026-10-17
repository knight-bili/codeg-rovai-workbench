use super::*;

fn fixture() -> (Arc<Manager>, Arc<Entry>, mpsc::Receiver<Control>, String) {
    let epoch = uuid::Uuid::new_v4().to_string();
    let manager = Manager::new(
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
        epoch.clone(),
    )
    .unwrap();
    let target = TerminalTarget {
        board_id: "board".into(),
        node_id: "terminal".into(),
    };
    let request = StartTerminal {
        target: target.clone(),
        core_generation: epoch,
        request_id: uuid::Uuid::new_v4().to_string(),
        expected_generation: None,
        cols: 80,
        rows: 24,
    };
    let generation = uuid::Uuid::new_v4().to_string();
    let mut session = Session::new(
        request.request_id.clone(),
        generation.clone(),
        Size::new(80, 24).unwrap(),
    );
    session.commit_spawn().unwrap();
    let (controls, receiver) = mpsc::channel(32);
    let (stop, _) = watch::channel(false);
    let (changed, _) = watch::channel(0);
    let (done, _) = watch::channel(false);
    let entry = Arc::new(Entry {
        request,
        data: Mutex::new(Data {
            session,
            inputs: VecDeque::new(),
            input_sequence: 0,
            issue: None,
        }),
        controls,
        stop,
        changed,
        done,
        forget: AtomicBool::new(false),
        last_used: AtomicU64::new(0),
    });
    manager.entries().unwrap().insert(target, entry.clone());
    (manager, entry, receiver, generation)
}

#[tokio::test]
async fn input_admission_keeps_original_sequence_bytes_and_receipt_without_redelivery() {
    let (manager, entry, mut receiver, generation) = fixture();
    let first = WriteTerminal {
        target: entry.request.target.clone(),
        generation: generation.clone(),
        input_id: uuid::Uuid::new_v4().to_string(),
        expected_input_sequence: 0,
        bytes_base64: STANDARD.encode(b"echo once\r"),
    };
    let wait = manager.enqueue_write(first.clone()).unwrap();
    let retry = manager.enqueue_write(first.clone()).unwrap();
    assert!(
        matches!(receiver.try_recv(),Ok(Control::Write { input_id, .. }) if input_id==first.input_id)
    );
    assert!(receiver.try_recv().is_err());
    assert_eq!(entry.data().unwrap().input_sequence, 1);
    let mut conflict = first.clone();
    conflict.bytes_base64 = STANDARD.encode(b"different");
    assert!(manager.enqueue_write(conflict).is_err());
    let mut next = first.clone();
    next.input_id = uuid::Uuid::new_v4().to_string();
    next.expected_input_sequence = 1;
    assert!(
        manager.enqueue_write(next.clone()).is_err(),
        "pending original blocks later input"
    );
    let mut stale = first.clone();
    stale.generation = uuid::Uuid::new_v4().to_string();
    assert!(manager.enqueue_write(stale).is_err());
    entry.data().unwrap().inputs.back_mut().unwrap().status = "written";
    entry.notify();
    assert_eq!(wait.wait().await.unwrap().status, "written");
    assert_eq!(retry.wait().await.unwrap().input_id, first.input_id);
    assert!(receiver.try_recv().is_err());
    // 超过真实64条回执上限，证明过期原序号被拒绝而不是重新派发。
    for sequence in 1..=INPUT_HISTORY as u64 + 1 {
        let mut request = next.clone();
        request.expected_input_sequence = sequence;
        request.input_id = uuid::Uuid::new_v4().to_string();
        let _ = manager.enqueue_write(request).unwrap();
        assert!(matches!(receiver.try_recv(), Ok(Control::Write { .. })));
        entry.data().unwrap().inputs.back_mut().unwrap().status = "written";
    }
    assert_eq!(entry.data().unwrap().inputs.len(), INPUT_HISTORY);
    assert!(manager.enqueue_write(first).is_err());
    assert!(receiver.try_recv().is_err());
    entry.stop();
    next.expected_input_sequence = entry.data().unwrap().input_sequence;
    assert!(manager.enqueue_write(next).is_err());
    assert_eq!(entry.data().unwrap().session.phase(), Phase::Stopping);
    assert!(
        !entry.finished(),
        "stop request alone does not prove process cleanup"
    );
    entry.done.send_replace(true);
    manager.forget(&entry.request.target).unwrap();
    assert!(manager.entries().unwrap().is_empty());
}

#[tokio::test]
async fn helper_frames_preserve_split_packets_and_refuse_partial_oversize_or_open_shapes() {
    let (mut write, read) = tokio::io::duplex(16);
    let writer = tokio::spawn(async move {
        write.write_all(b"{\"kind\":\"rea").await.unwrap();
        tokio::task::yield_now().await;
        write.write_all(b"dy\"}\n").await.unwrap();
    });
    let mut read = BufReader::new(read);
    assert!(matches!(
        read_frame(&mut read).await.unwrap(),
        Some(HelperOutput::Ready {})
    ));
    writer.await.unwrap();
    assert!(read_frame(&mut read).await.unwrap().is_none());
    for bytes in [
        b"{\"kind\":\"ready\"}".to_vec(),
        b"{\"kind\":\"ready\",\"injected\":true}\n".to_vec(),
        vec![b'x'; FRAME_LIMIT + 1],
    ] {
        let mut read = BufReader::new(bytes.as_slice());
        assert!(read_frame(&mut read).await.is_err());
    }
    assert_eq!(
        serde_json::to_value(HelperOutput::Ready {}).unwrap(),
        serde_json::json!({ "kind": "ready" })
    );
    assert_eq!(
        serde_json::to_value(HelperInput::Stop {}).unwrap(),
        serde_json::json!({ "op": "stop" })
    );
    assert!(matches!(
        serde_json::from_str::<HelperInput>(r#"{"op":"stop"}"#).unwrap(),
        HelperInput::Stop {}
    ));
    assert!(serde_json::from_str::<HelperInput>(r#"{"op":"stop","injected":true}"#).is_err());
}
